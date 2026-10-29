import type { Product } from '../../types';
import { getProduct } from '../../services/api';
import { getBoard } from '../../services/boards';
import type { BoardBatch } from '../../services/boards';
import { validateLabelId } from './links';
import type { LabelKind } from './links';

export function fetchLatestLabelRecord(kind: 'finished-product', id: string | number): Promise<Product>;
export function fetchLatestLabelRecord(kind: 'paperboard-batch', id: string): Promise<BoardBatch>;
export function fetchLatestLabelRecord(kind: LabelKind, id: string | number): Promise<Product | BoardBatch>;
export async function fetchLatestLabelRecord(kind: LabelKind, id: string | number): Promise<Product | BoardBatch> {
  const checked = validateLabelId(kind, id);
  // This read must start after the preview/print action, never reuse an earlier in-flight response.
  if (kind === 'finished-product') {
    const record = await getProduct(Number(checked), { forceNetwork: true });
    if (!record || String(record.id) !== checked || record.deleted_at) throw new Error('商品已删除或不存在，请重新选择');
    return record;
  }
  const record = await getBoard(checked, { forceNetwork: true });
  if (!record || record.id !== checked) throw new Error('纸板批次已删除或不存在，请重新选择');
  return record;
}
