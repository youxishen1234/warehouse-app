// Customer delivery documents are independent of stock and accounting entries.
const { numberValue, lineAmount } = require('./stock-math');
const { parseDateQuery } = require('./date-query');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function normalizeSpecification(value) {
  return String(value ?? '').replace(/(\d)\s*(?:mm|ｍｍ|毫米)(?=\s*(?:[×xX*＊✕]|乘|$))/gi, '$1')
    .replace(/\s*(?:[×xX*＊✕]|乘)\s*/g, '×').trim();
}
function validateNote(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('送货单内容无效');
  const text = (value, label, limit, required = false) => {
    if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw fail(`${label}${required ? '不能为空，且' : ''}最多 ${limit} 字`);
    return value.trim();
  };
  const date = text(raw.date, '送货日期', 10, true);
  try { parseDateQuery(date); } catch { throw fail('请填写有效的送货日期'); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail('请填写有效的送货日期');
  if (!['241-93', '241-140', 'a4'].includes(raw.paper)) throw fail('请选择纸张');
  const customerId = raw.customer_id == null ? null : raw.customer_id;
  if (customerId !== null && (!Number.isSafeInteger(customerId) || customerId < 1)) throw fail('客户编号无效');
  if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 200) throw fail('请填写 1 至 200 行货物明细');
  const items = raw.items.map((item, index) => {
    if (!item || typeof item !== 'object') throw fail(`第 ${index + 1} 行内容无效`);
    let quantity, price, amount;
    try {
      quantity = numberValue(item.quantity, `第 ${index + 1} 行数量`, true);
      price = numberValue(item.price, `第 ${index + 1} 行单价`);
      amount = lineAmount(quantity, price);
    } catch (error) { throw fail(error.message); }
    const productId = item.product_id == null || item.product_id === '' ? null : item.product_id;
    if (productId !== null && (!Number.isSafeInteger(productId) || productId < 1)) throw fail(`第 ${index + 1} 行库存商品编号无效`);
    return { product_id: productId, name: text(item.name, `第 ${index + 1} 行产品名称`, 100, true),
      specification: normalizeSpecification(text(item.specification, '规格', 100)),
      unit: '个', quantity, price, amount, remark: text(item.remark, '备注', 250) };
  });
  const cents = items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
  if (!Number.isSafeInteger(cents) || cents >= 1e14) throw fail('合计金额超出支持范围');
  return { company: text(raw.company, '公司抬头', 50, true), customer_id: customerId,
    customer_name: text(raw.customer_name, '收货单位', 100, true), address: text(raw.address, '收货地址', 200),
    phone: text(raw.phone, '联系电话', 30), receiver: text(raw.receiver, '收货人', 50),
    sender: text(raw.sender, '送货人', 50), date, paper: raw.paper, items, total: cents / 100 };
}
function list(data, keyword = '') {
  const query = String(keyword).trim().toLocaleLowerCase();
  return (data.print_notes || []).filter(note => !query || [note.number, note.customer_name, note.date, note.address, note.phone, ...note.items.map(item => `${item.name} ${item.specification} ${item.remark}`)].join(' ').toLocaleLowerCase().includes(query))
    .slice().sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
}
function save(data, raw, id) {
  const notes = data.print_notes || (data.print_notes = []);
  const previous = id == null ? null : notes.find(note => note.id === id);
  if (id != null && !previous) throw fail('送货单不存在', 404);
  if (previous?.outbound_at) throw fail('送货单已出库，不能再修改明细；可以直接重复打印');
  if (previous && raw?.version !== previous.version) throw fail('这张送货单已被修改，请重新打开后再编辑；当前内容仍保留', 409);
  const note = validateNote(raw);
  if (note.customer_id != null && !data.customers.some(customer => customer.id === note.customer_id && (!customer.deleted_at || previous?.customer_id === customer.id))) throw fail('所选客户不存在或已停用，请重新选择');
  for (const [index, item] of note.items.entries()) {
    if (item.product_id == null) continue;
    const product = data.products.find(row => row.id === item.product_id && !row.deleted_at);
    if (!product) throw fail(`第 ${index + 1} 行库存商品不存在或已停用，请重新选择`);
    if (String(product.unit || '件') !== '个') throw fail(`第 ${index + 1} 行库存商品单位为「${product.unit || '件'}」，送货单出库要求单位为「个」`);
  }
  const nextId = previous?.id ?? notes.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  const now = Date.now();
  const result = { ...note, id: nextId, number: previous?.number || `SH-${note.date.replace(/-/g, '')}-${String(nextId).padStart(5, '0')}`,
    version: (previous?.version || 0) + 1, created_at: previous?.created_at || now, updated_at: now };
  if (previous) notes[notes.indexOf(previous)] = result; else notes.push(result);
  return result;
}
function validateBackup(data) {
  if (data.print_notes === undefined) return;
  if (!Array.isArray(data.print_notes)) throw fail('送货单备份格式无效');
  const ids = new Set();
  for (const note of data.print_notes) {
    const normalized = validateNote(note);
    if (!Number.isSafeInteger(note.id) || note.id < 1 || ids.has(note.id) || typeof note.number !== 'string' || !note.number || note.number.length > 80
      || !Number.isSafeInteger(note.version) || note.version < 1 || !Number.isSafeInteger(note.created_at) || note.created_at < 0
      || !Number.isSafeInteger(note.updated_at) || note.updated_at < 0 || normalized.total !== note.total
      || normalized.items.some((item, i) => item.amount !== note.items[i].amount || note.items[i].unit !== '个')) throw fail('送货单备份编号、版本或金额无效');
    ids.add(note.id);
  }
}
module.exports = { normalizeSpecification, validateNote, list, save, validateBackup };
