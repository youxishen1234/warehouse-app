const crypto = require('node:crypto');
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

function normalizeFlute(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, '').replace(/楞$/u, '').toUpperCase();
}

function fluteMatches(productValue, batchValue) {
  if (!String(productValue || '').trim()) return true;
  return normalizeFlute(productValue) === normalizeFlute(batchValue);
}

// Compare dimensions in centimetres, without confusing a board's two axes with a box's three.
function sizeInCm(value, unit = '') {
  const text = String(value || '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*[×xX*＊]\s*(\d+(?:\.\d+)?)(?:\s*[×xX*＊]\s*(\d+(?:\.\d+)?))?\s*(mm|cm|毫米|厘米)?$/i.exec(text);
  if (!match) return null;
  const scale = /^(mm|毫米)$/i.test(match[4] || unit) ? 0.1 : /^(cm|厘米)$/i.test(match[4] || unit) ? 1 : null;
  if (scale === null) return null;
  const dimensions = match.slice(1, 4).filter(Boolean).map(n => Math.round(Number(n) * scale * 1e6) / 1e6);
  return dimensions.every(n => Number.isFinite(n) && n > 0 && n <= 1e8) ? dimensions : null;
}
const cartonSize = batch => [batch.cartonLength, batch.cartonWidth, batch.cartonHeight];
const sizeLabel = dimensions => dimensions.join(' × ') + ' cm';
function specifications(data) {
  const rows = [];
  for (const batch of data.board_batches || []) rows.push({ id: 'board:' + batch.id, source: 'board', source_id: batch.id, kind: '纸板', name: batch.supplier, board: [batch.boardLength, batch.boardWidth], carton: cartonSize(batch), material: '', fluteType: batch.fluteType, layers: batch.layers, updated_at: batch.createdAt });
  for (const product of data.products || []) {
    if (product.deleted_at) continue;
    const size = sizeInCm(product.specification);
    if (!size) continue;
    rows.push({ id: 'product:' + product.id, source: 'product', source_id: String(product.id), kind: size.length === 3 ? '成品' : '纸板', name: product.name, ...(size.length === 3 ? { carton: size } : { board: size }), material: product.material || '', fluteType: product.corrugation || '', layers: product.layers || 0, updated_at: product.profile_updated_at || product.updated_at });
  }
  for (const customer of data.customer_dimensions?.customers || []) for (const spec of customer.specs) {
    const size = sizeInCm(spec.size, spec.sizeUnit);
    if (!size) continue;
    rows.push({ id: 'customer:' + customer.id + ':' + spec.id, source: 'customer', source_id: spec.id, kind: spec.kind, name: customer.name + ' · ' + spec.goods, ...(size.length === 3 ? { carton: size } : { board: size }), material: spec.material, updated_at: 0 });
  }
  return rows;
}
function complete(data, raw, operator, stockIn, addProduct) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('请填写生产完工单');
  const batch = (data.board_batches || []).find(b => b.id === raw.batch_id);
  if (!batch) fail('纸板批次不存在，请重新选择');
  const integer = (n, label) => { if (!Number.isSafeInteger(n) || n <= 0 || n > 1e8) fail(label + '请填写一到一亿的整数'); return n; };
  const consumed = integer(raw.consumed_quantity, '领用纸板数');
  const quantity = integer(raw.quantity, '合格纸箱数');
  if (consumed > batch.remainingQty) fail('纸板库存不足，当前剩余 ' + batch.remainingQty + ' 张');
  const remark = String(raw.remark || '').trim();
  if (remark.length > 500) fail('备注最多500字');
  const size = cartonSize(batch), specification = sizeLabel(size);
  let product;
  if (raw.product_id != null) {
    product = data.products.find(p => p.id === raw.product_id && !p.deleted_at);
    const dimensions = product && sizeInCm(product.specification);
    if (!dimensions || dimensions.length !== 3 || dimensions.some((n, i) => n !== size[i])) fail('纸箱规格与纸板对应成箱尺寸不一致，请重新选择');
    if (!['个', '只', '件'].includes(product.unit) || product.category === '纸板') fail('请选择以个、只或件计数的纸箱商品');
    if (!fluteMatches(product.corrugation, batch.fluteType) || (product.layers && product.layers !== batch.layers)) fail('纸箱楞型或层数与领用纸板不一致');
  } else {
    const name = String(raw.product_name || '').trim();
    if (!name || name.length > 100) fail('请填写纸箱名称（最多100字）');
    const matches = data.products.filter(p => !p.deleted_at && p.name === name && p.specification === specification && fluteMatches(p.corrugation, batch.fluteType) && p.layers === batch.layers && p.unit === '个');
    if (matches.length > 1) fail('有多个相同商品，请指定纸箱商品');
    product = matches[0] || addProduct({ name, category: '纸箱', specification, unit: '个', stock: 0, price: 0, corrugation: batch.fluteType, layers: batch.layers });
  }
  const id = 'PROD-' + crypto.randomUUID();
  const snapshot = { board: [batch.boardLength, batch.boardWidth], carton: size, size_unit: 'cm', flute_type: batch.fluteType, layers: batch.layers, face_gsm: batch.faceGsm, liner_gsm: batch.linerGsm, fluting_gsm: batch.flutingGsm };
  const board = require('./boards').move(data, batch.id, { type: 'out', quantity: consumed, recipient: operator, remark: '生产完工 ' + id + (remark ? ' · ' + remark : '') });
  const movement = board.movements[0]; movement.production_id = id;
  Object.assign(data.board_movements.find(m => m.id === movement.id), { production_id: id });
  // Production is an internal transfer, not another purchase or supplier payable.
  const result = stockIn(product.id, quantity, operator, '生产完工 · ' + id, null, { specification: product.specification, unit_price: 0 });
  Object.assign(result.transaction, { production_id: id, board_batch_id: batch.id, specification_snapshot: snapshot });
  const record = { id, batch_id: batch.id, product_id: product.id, product_name: product.name, specification: product.specification, unit: product.unit, consumed_quantity: consumed, quantity, board_movement_id: movement.id, transaction_id: result.transaction.id, specification_snapshot: snapshot, operator, remark, created_at: Date.now() };
  data.production_records ||= []; data.production_records.push(record);
  return record;
}
function validate(data) {
  for (const batch of data.board_batches || []) {
    if (!batch.ledger_id) continue; // Legacy batches predate linked payables.
    const entry = data.ledger?.find(e => e.id === batch.ledger_id);
    if (!entry || entry.voided_at || entry.board_batch_id !== batch.id || entry.party_type !== 'supplier' || entry.type !== 'payable' || entry.party_id !== batch.supplier_id || entry.amount !== batch.amount || !data.suppliers?.some(s => s.id === batch.supplier_id)) fail('纸板入库与供货商账单不一致');
  }
  if (data.production_records === undefined) return;
  if (!Array.isArray(data.production_records)) fail('生产记录格式无效');
  const ids = new Set();
  for (const record of data.production_records) {
    const movement = data.board_movements?.find(m => m.id === record.board_movement_id);
    const tx = data.transactions?.find(t => t.id === record.transaction_id);
    const batch = data.board_batches?.find(b => b.id === record.batch_id);
    const snapshot = record.specification_snapshot;
    if (!record.id || ids.has(record.id) || !movement || !tx || !batch || movement.production_id !== record.id || tx.production_id !== record.id || movement.batchId !== record.batch_id || tx.product_id !== record.product_id || movement.quantity !== record.consumed_quantity || tx.quantity !== record.quantity || tx.type !== 'in' || tx.voided_at || tx.supplier_id != null || tx.amount !== 0 || !snapshot || snapshot.size_unit !== 'cm' || JSON.stringify(snapshot) !== JSON.stringify(tx.specification_snapshot) || JSON.stringify(snapshot.carton) !== JSON.stringify(cartonSize(batch)) || JSON.stringify(snapshot.board) !== JSON.stringify([batch.boardLength, batch.boardWidth])) fail('生产领料与完工入库记录不一致');
    ids.add(record.id);
  }
}
module.exports = { normalizeFlute, sizeInCm, specifications, complete, validate };
