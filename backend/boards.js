// Paperboard batches share the main database transaction, backup and revision.
const crypto = require('node:crypto');
const { roundDecimal, localDate } = require('./stock-math');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, label, required = false, max = 120) => {
  if (value != null && typeof value !== 'string') fail(`${label}格式不正确`);
  const result = (value || '').trim();
  if ((required && !result) || result.length > max) fail(`${label}${required && !result ? '不能为空' : '过长'}`);
  return result;
};
const number = (value, label, positive = false, integer = false) => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') fail(`请填写${label}`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 100000000 || (positive && result === 0) || (integer && !Number.isSafeInteger(result))) fail(`${label}必须为${positive ? '正' : '非负'}${integer ? '整数' : '数'}，且不超过一亿`);
  return result;
};
const round = (value, digits = 2) => roundDecimal(value, digits);
function validateSpec(raw) {
  const spec = {};
  for (const field of ['boardLength', 'boardWidth', 'cartonLength', 'cartonWidth', 'cartonHeight']) spec[field] = number(raw[field], field.startsWith('board') ? '纸板尺寸（cm）' : '纸箱尺寸（cm）', true);
  for (const field of ['faceGsm', 'linerGsm', 'flutingGsm']) spec[field] = number(raw[field] ?? 0, '克重');
  spec.fluteType = text(raw.fluteType, '楞型', true, 12).toUpperCase();
  if (!/^[A-Z]{1,4}$/.test(spec.fluteType)) fail('楞型请填写字母，例如 B、AB 或 BC');
  spec.layers = number(raw.layers ?? 3, '层数', true, true);
  if (![2, 3, 5, 7].includes(spec.layers)) fail('层数请选择 2、3、5 或 7');
  return spec;
}
const specKey = spec => ['boardLength', 'boardWidth', 'fluteType', 'layers', 'faceGsm', 'linerGsm', 'flutingGsm', 'cartonLength', 'cartonWidth', 'cartonHeight'].map(k => spec[k]).join('|');
function state(data) {
  return { batches: data.board_batches || [], movements: data.board_movements || [] };
}
function list(data) {
  const { batches, movements } = state(data);
  const byBatch = new Map();
  for (let i = movements.length - 1; i >= 0; i--) {
    const movement = movements[i], entries = byBatch.get(movement.batchId);
    if (entries) entries.push(movement); else byBatch.set(movement.batchId, [movement]);
  }
  return batches.map(batch => ({ ...batch, movements: byBatch.get(batch.id) || [] })).reverse();
}
function receive(data, raw) {
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') fail('入库单格式不正确');
  const spec = validateSpec(raw);
  const supplier = text(raw.supplier, '板厂', true);
  const orderedQty = number(raw.orderedQty, '订购数', true, true);
  const receivedQty = number(raw.receivedQty, '实收数', true, true);
  const billedArea = number(raw.billedArea, '计费平米', true);
  const unitPrice = number(raw.unitPrice, '每平米单价');
  const amount = round(billedArea * unitPrice);
  if (amount > 100000000) fail('货款超出支持范围');
  const date = text(raw.date, '送货日期', true, 10);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) fail('送货日期无效');
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (date > today) fail('送货日期不能晚于今天');
  const batch = { ...spec, id: `BOARD-${date.replace(/-/g, '')}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, specKey: specKey(spec), supplier, orderedQty, receivedQty, remainingQty: receivedQty, giftQty: Math.max(0, receivedQty - orderedQty), shortageQty: Math.max(0, orderedQty - receivedQty), billedArea, unitPrice, amount, date, deliveryNo: text(raw.deliveryNo, '送货单号'), location: text(raw.location, '库位'), remark: text(raw.remark, '备注', false, 500), warningQty: number(raw.warningQty ?? 0, '预警数量', false, true), createdAt: Date.now() };
  data.board_batches ||= []; data.board_movements ||= [];
  data.board_batches.push(batch);
  data.board_movements.push({ id: crypto.randomUUID(), batchId: batch.id, type: 'in', quantity: receivedQty, balance: receivedQty, date, remark: batch.remark, createdAt: batch.createdAt });
  return batch;
}
function move(data, id, raw) {
  const batch = state(data).batches.find(b => b.id === id);
  if (!batch) fail('找不到这批纸板，请检查标签', 404);
  if (!raw || !['out', 'count'].includes(raw.type)) fail('操作类型无效');
  const value = number(raw.quantity, raw.type === 'out' ? '领料数量' : '实盘数量', raw.type === 'out', true);
  if (raw.type === 'out' && value > batch.remainingQty) fail(`库存不足，当前剩余 ${batch.remainingQty} 张`);
  const remark = text(raw.remark, raw.type === 'count' ? '盘点原因' : '用途备注', raw.type === 'count', 500);
  const recipient = text(raw.recipient, '领料人');
  const before = batch.remainingQty;
  const balance = raw.type === 'out' ? before - value : value;
  if (before === balance) fail('实盘数量与账面一致，无需调整');
  const movement = { id: crypto.randomUUID(), batchId: id, type: raw.type, quantity: raw.type === 'out' ? value : balance - before, before, balance, recipient, remark, date: localDate(), createdAt: Date.now() };
  batch.remainingQty = balance;
  data.board_movements ||= []; data.board_movements.push(movement);
  return { ...batch, movements: data.board_movements.filter(m => m.batchId === id).slice().reverse() };
}
function validate(data) {
  if (data.board_batches === undefined && data.board_movements === undefined) return;
  if (!Array.isArray(data.board_batches) || !Array.isArray(data.board_movements)) fail('纸板备份缺少批次或流水');
  const ids = new Set(); const movementIds = new Set();
  const byBatch = new Map();
  for (const movement of data.board_movements) {
    const entries = byBatch.get(movement.batchId);
    if (entries) entries.push(movement); else byBatch.set(movement.batchId, [movement]);
  }
  for (const b of data.board_batches) {
    if (!/^BOARD-[0-9]{8}-[A-F0-9]{12}$/.test(b.id) || ids.has(b.id)) fail('纸板批次编号无效或重复');
    ids.add(b.id); validateSpec(b);
    if (b.specKey !== specKey(b)) fail('纸板规格索引不一致');
    text(b.supplier, '板厂', true); number(b.remainingQty, '批次库存', false, true); number(b.receivedQty, '实收数', true, true); number(b.orderedQty, '订购数', true, true);
    number(b.billedArea, '计费平米', true); number(b.unitPrice, '每平米单价'); number(b.warningQty, '预警数量', false, true);
    if (b.amount !== round(b.billedArea * b.unitPrice) || b.giftQty !== Math.max(0, b.receivedQty - b.orderedQty) || b.shortageQty !== Math.max(0, b.orderedQty - b.receivedQty)) fail('纸板金额或赠送数量不一致');
    if (typeof b.date !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(b.date) || !Number.isFinite(Date.parse(b.date)) || new Date(b.date).toISOString().slice(0, 10) !== b.date) fail('纸板批次日期无效');
    let balance = 0; let inbound = 0;
    for (const m of byBatch.get(b.id) || []) {
      if (!['in', 'out', 'count'].includes(m.type) || !Number.isSafeInteger(m.quantity) || !Number.isSafeInteger(m.createdAt)) fail('纸板流水无效');
      if (m.date !== undefined && (typeof m.date !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(m.date) || !Number.isFinite(Date.parse(m.date)))) fail('纸板流水日期无效');
      if (m.type === 'in') { inbound++; if (inbound !== 1 || balance !== 0 || m.quantity !== b.receivedQty) fail('纸板入库流水不一致'); }
      else if (!inbound || m.before !== balance || (m.type === 'out' && m.quantity <= 0)) fail('纸板领料流水不一致');
      balance += m.type === 'out' ? -m.quantity : m.quantity;
      if (balance < 0 || balance !== m.balance) fail('纸板流水余额不一致');
    }
    if (inbound !== 1 || balance !== b.remainingQty) fail('纸板库存与流水不一致');
  }
  for (const m of data.board_movements) { if (!ids.has(m.batchId) || !m.id || movementIds.has(m.id)) fail('纸板流水引用无效或重复'); movementIds.add(m.id); }
}
function update(data, id, raw) {
  const batch = state(data).batches.find(b => b.id === id);
  if (!batch) fail('找不到这批纸板', 404);
  const movements = state(data).movements.filter(m => m.batchId === id);
  if (movements.some(m => m.type !== 'in')) fail('已有领料或盘点记录，不能编辑入库单，请使用盘点功能调整库存');
  const draft = {};
  const next = receive(draft, raw);
  Object.assign(batch, next, { id, createdAt: batch.createdAt });
  Object.assign(movements[0], { quantity: next.receivedQty, balance: next.receivedQty, date: next.date, remark: next.remark });
  return list(data).find(b => b.id === id);
}
function remove(data, id) {
  const batch = state(data).batches.find(b => b.id === id);
  if (!batch) fail('找不到这批纸板', 404);
  if (state(data).movements.some(m => m.batchId === id && m.type !== 'in')) fail('已有领料或盘点记录，不能删除这批纸板');
  data.board_batches = data.board_batches.filter(b => b.id !== id);
  data.board_movements = data.board_movements.filter(m => m.batchId !== id);
  return { id };
}
module.exports = { list, receive, move, update, remove, validate };
