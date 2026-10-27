import type { Product } from '../../types';
import type { BoardBatch, BoardMovement } from '../../services/boards';
import { buildLabelUrl, validateLabelId } from './links';
import type { LabelKind } from './links';

export const LABEL_TEMPLATE_VERSION = 1;
export type LabelIssue = Readonly<{ field: string; message: string }>;
export class LabelValidationError extends Error {
  readonly issues: readonly LabelIssue[];
  constructor(field: string, message: string) {
    super(message); this.name = 'LabelValidationError';
    this.issues = Object.freeze([Object.freeze({ field, message })]);
  }
}

export type FinishedLabelSnapshot = Readonly<{
  productId: number; name: string; specification: string; unit: string; productUrl: string;
  material?: string; corrugation?: string; layers?: number; weight?: number; stockSnapshot?: number; printedAt?: string;
}>;
export type BoardLabelSnapshot = Readonly<{
  customerName?: string; material?: string; printPlate?: string; printColor?: string;
  batchId: string; boardLength: number; boardWidth: number; fluteType: string; supplier: string; batchUrl: string;
  layers?: number; faceGsm?: number; linerGsm?: number; flutingGsm?: number;
  cartonLength?: number; cartonWidth?: number; cartonHeight?: number;
  receivedDate?: string; location?: string; receivedQty?: number; remainingQtySnapshot?: number;
}>;
/** A print-only paperboard draft with no stock batch ID or resolver URL. */
export type ManualBoardLabelSnapshot = Readonly<{
  customerName: string; boardLength: number; boardWidth: number; boardHeight: number; material: string;
  printPlate?: string; printColor?: string; receivedQty?: number; receivedDate?: string;
}>;
export type LabelSnapshot = FinishedLabelSnapshot | BoardLabelSnapshot | ManualBoardLabelSnapshot;
/** Remote USB labels may include a stock-free, manually entered paperboard label. */
export type RemotePrintableLabelKind = LabelKind | 'paperboard-manual';
export type FinishedLabelOptions = Readonly<{ material?: boolean; corrugation?: boolean; layers?: boolean; weight?: boolean; stockSnapshot?: boolean; printedAt?: boolean }>;
export type BoardLabelOptions = Readonly<{ layers?: boolean; faceGsm?: boolean; linerGsm?: boolean; flutingGsm?: boolean; cartonDimensions?: boolean; receivedDate?: boolean; location?: boolean; receivedQty?: boolean; remainingQtySnapshot?: boolean }>;

function fail(field: string, message: string): never { throw new LabelValidationError(field, message); }
function text(value: unknown, field: string, title: string, required = true, max = 120): string {
  if (value === undefined || value === null) { if (!required) return ''; return fail(field, `请补全${title}`); }
  if (typeof value !== 'string') return fail(field, `${title}格式无效`);
  const result = value.trim();
  if (!result && required) return fail(field, `请补全${title}`);
  if (result.length > max) return fail(field, `${title}超过 ${max} 字，请修正资料或关闭该可选字段`);
  if (/[\u0000-\u001f\u007f\ufffd]/.test(result)) return fail(field, `${title}包含无法打印的字符，请修正资料`);
  return result;
}
function number(value: unknown, field: string, title: string, positive: boolean, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000000 || (positive && value === 0) || (integer && !Number.isSafeInteger(value))) {
    return fail(field, `${title}必须是有效的${positive ? '正' : '非负'}${integer ? '整数' : '数值'}`);
  }
  return value;
}
function optionalText(value: unknown, field: string, title: string): string | undefined { return text(value, field, title, false) || undefined; }
function optionalPositive(value: unknown, field: string, title: string, integer = false): number | undefined {
  if (value === undefined || value === null || value === '' || value === 0) return undefined;
  return number(value, field, title, true, integer);
}
function date(value: unknown, field: string, title: string): string | undefined {
  const result = optionalText(value, field, title);
  if (result === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) return fail(field, `${title}无效`);
  return result;
}

export function productSpecification(product: Product): string {
  const specification = text(product.specification, 'specification', '商品规格', false, 240);
  if (specification) return specification;
  const length = number(product.length, 'length', '商品长度（mm）', true);
  const width = number(product.width, 'width', '商品宽度（mm）', true);
  return `${length} × ${width} mm`;
}

export function buildFinishedLabelSnapshot(product: Product, options: FinishedLabelOptions = {}, printedAtIso?: string): FinishedLabelSnapshot {
  const id = validateLabelId('finished-product', product.id);
  if (product.deleted_at) return fail('productId', '商品已删除，请选择其他商品');
  const snapshot: { -readonly [K in keyof FinishedLabelSnapshot]: FinishedLabelSnapshot[K] } = {
    productId: Number(id), name: text(product.name, 'name', '商品名称', true, 160),
    specification: productSpecification(product), unit: text(product.unit, 'unit', '库存单位', options.stockSnapshot === true, 24),
    productUrl: buildLabelUrl('finished-product', id)
  };
  if (options.material === true) { const value = optionalText(product.material, 'material', '材质'); if (value !== undefined) snapshot.material = value; }
  if (options.corrugation === true) { const value = optionalText(product.corrugation, 'corrugation', '楞型'); if (value !== undefined) snapshot.corrugation = value; }
  if (options.layers === true) { const value = optionalPositive(product.layers, 'layers', '层数', true); if (value !== undefined) snapshot.layers = value; }
  if (options.weight === true) { const value = optionalPositive(product.weight, 'weight', '克重（g/m²）'); if (value !== undefined) snapshot.weight = value; }
  if (options.stockSnapshot === true) snapshot.stockSnapshot = number(product.stock, 'stockSnapshot', '打印时库存', false);
  if (options.printedAt === true) {
    if (!printedAtIso || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(printedAtIso) || !Number.isFinite(Date.parse(printedAtIso)) || new Date(printedAtIso).toISOString() !== printedAtIso) return fail('printedAt', '打印日期无效，请重新预览');
    snapshot.printedAt = printedAtIso;
  }
  return Object.freeze(snapshot);
}

export function buildBoardLabelSnapshot(batch: BoardBatch, options: BoardLabelOptions = {}): BoardLabelSnapshot {
  const id = validateLabelId('paperboard-batch', batch.id);
  const snapshot: { -readonly [K in keyof BoardLabelSnapshot]: BoardLabelSnapshot[K] } = {
    batchId: id, boardLength: number(batch.boardLength, 'boardLength', '纸板长度（cm）', true),
    boardWidth: number(batch.boardWidth, 'boardWidth', '纸板宽度（cm）', true),
    fluteType: text(batch.fluteType, 'fluteType', '楞型', true, 12),
    supplier: text(batch.supplier, 'supplier', '板厂'), batchUrl: buildLabelUrl('paperboard-batch', id)
  };
  for (const [field, title] of [['customerName', '客户'], ['material', '材质/配纸'], ['printPlate', '印刷版名'], ['printColor', '颜色']] as const) {
    const value = optionalText(batch[field], field, title);
    if (value !== undefined) snapshot[field] = value;
  }
  for (const [field, title] of [['layers', '层数'], ['faceGsm', '面纸克重（g/m²）'], ['linerGsm', '里纸克重（g/m²）'], ['flutingGsm', '楞纸克重（g/m²）']] as const) {
    if (options[field] === true) { const value = optionalPositive(batch[field], field, title, field === 'layers'); if (value !== undefined) snapshot[field] = value; }
  }
  if (options.cartonDimensions === true) {
    snapshot.cartonLength = number(batch.cartonLength, 'cartonLength', '纸箱长度（cm）', true);
    snapshot.cartonWidth = number(batch.cartonWidth, 'cartonWidth', '纸箱宽度（cm）', true);
    snapshot.cartonHeight = number(batch.cartonHeight, 'cartonHeight', '纸箱高度（cm）', true);
  }
  if (options.receivedDate === true) { const value = date(batch.date, 'receivedDate', '入库日期'); if (value !== undefined) snapshot.receivedDate = value; }
  if (options.location === true) { const value = optionalText(batch.location, 'location', '库位'); if (value !== undefined) snapshot.location = value; }
  if (options.receivedQty === true) snapshot.receivedQty = number(batch.receivedQty, 'receivedQty', '实收数量（张）', false, true);
  if (options.remainingQtySnapshot === true) snapshot.remainingQtySnapshot = number(batch.remainingQty, 'remainingQtySnapshot', '打印时余量（张）', false, true);
  return Object.freeze(snapshot);
}

export function buildManualBoardLabelSnapshot(input: {
  customerName: unknown; boardLength: unknown; boardWidth: unknown; boardHeight: unknown; material: unknown;
  printPlate?: unknown; printColor?: unknown; receivedQty?: unknown; receivedDate?: unknown;
}): ManualBoardLabelSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('manual', '手填纸板标签资料无效');
  const snapshot: { -readonly [K in keyof ManualBoardLabelSnapshot]: ManualBoardLabelSnapshot[K] } = {
    customerName: text(input.customerName, 'customerName', '客户'),
    boardLength: number(input.boardLength, 'boardLength', '纸板长度（cm）', true),
    boardWidth: number(input.boardWidth, 'boardWidth', '纸板宽度（cm）', true),
    boardHeight: number(input.boardHeight, 'boardHeight', '纸板高度（cm）', true),
    material: text(input.material, 'material', '材质 / 配纸')
  };
  for (const [field, title] of [['printPlate', '印刷版名'], ['printColor', '颜色']] as const) {
    const value = optionalText(input[field], field, title);
    if (value !== undefined) snapshot[field] = value;
  }
  if (input.receivedQty !== undefined && input.receivedQty !== null && input.receivedQty !== '') {
    snapshot.receivedQty = number(input.receivedQty, 'receivedQty', '数量（张）', false, true);
  }
  if (input.receivedDate !== undefined && input.receivedDate !== null && input.receivedDate !== '') {
    const value = date(input.receivedDate, 'receivedDate', '日期');
    if (value !== undefined) snapshot.receivedDate = value;
  }
  return Object.freeze(snapshot);
}

export function changedSnapshotFields(before: LabelSnapshot, after: LabelSnapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(key => before[key] !== after[key]);
}
export function snapshotsEqual(before: LabelSnapshot, after: LabelSnapshot): boolean { return changedSnapshotFields(before, after).length === 0; }

export type SafeBoardMovement = Readonly<{ time: number; type: 'in' | 'out' | 'count'; quantity: number; balance: number }>;
export function safeBoardMovements(movements: readonly BoardMovement[]): readonly SafeBoardMovement[] {
  if (!Array.isArray(movements)) return Object.freeze([]);
  return Object.freeze(movements.filter(movement => movement && ['in', 'out', 'count'].includes(movement.type) &&
    typeof movement.createdAt === 'number' && Number.isFinite(movement.createdAt) && movement.createdAt > 0 && movement.createdAt <= 8640000000000000 &&
    typeof movement.quantity === 'number' && Number.isSafeInteger(movement.quantity) && Math.abs(movement.quantity) <= 100000000 && (movement.type === 'count' || movement.quantity >= 0) &&
    typeof movement.balance === 'number' && Number.isSafeInteger(movement.balance) && movement.balance >= 0 && movement.balance <= 100000000
  ).map(movement => Object.freeze({ time: movement.createdAt, type: movement.type, quantity: movement.quantity, balance: movement.balance })));
}
