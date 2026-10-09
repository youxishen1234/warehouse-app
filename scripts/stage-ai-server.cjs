// Extend the downloaded production baseline while preserving its authentication.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Provide production baseline and staging directories');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(destination, { recursive: true });
let server = fs.readFileSync(path.join(source, 'server.js'), 'utf8');
let team = fs.readFileSync(path.join(source, 'team.js'), 'utf8');
let db = fs.readFileSync(path.join(source, 'db.js'), 'utf8');
const parser = "app.use(express.json({ limit: '5mb' }));";
if (!server.includes(parser)) throw new Error('Production JSON parser has changed');
server = server.replace(parser, "app.use('/api/ai/command', express.json({ limit: '9mb' }));\n" + parser);
const marker = "  require('./customer-dimensions').install(router, db);";
if (!team.includes(marker) || team.includes("require('./ai')")) throw new Error('Production AI insertion point has changed');
team = team.replace(marker, marker + `
  router.use('/ai', (req, res, next) => {
    if (req.user.role === 'viewer' && req.path === '/execute' && (['stock_in', 'stock_out'].includes(req.body?.action) || require('./ai-tools').get(req.body?.action)?.mode === 'write')) return next(error('只读账号不能修改仓库资料', 403));
    const intent = req.body?.intent || req.body;
    if (req.user.role !== 'admin' && (intent?.parameters?.resource === 'audit' || req.path === '/command' && /操作记录|审计/.test(req.body?.message || ''))) return next(error('仅管理员可查看操作记录', 403));
    next();
  });
  require('./ai').install(router, new Proxy(db, { get(target, key) {
    if (key === 'audit') return () => [];
    return target[key];
  } }));
`);
// The deployed receipt implementation billed planned quantity and auto-created
// unmatched products. Replace only that operation; preserve the live database.
const start = db.indexOf('function addDeliveryNote(data){');
const end = db.indexOf('let cache = load();', start);
if (start < 0 || end < 0) throw new Error('Production receipt implementation has changed');
db = db.slice(0, start) + `function addDeliveryNote(data) {
  const { numberValue, roundDecimal, lineAmount, dimensions, localDate } = require('./stock-math');
  if (!Array.isArray(data.lines) || !data.lines.length) throw new Error('至少添加一行商品');
  const supplier = data.supplier_id ? getSupplier(Number(data.supplier_id)) : null;
  if (data.supplier_id && (!supplier || supplier.deleted_at)) throw new Error('供应商不存在或已停用');
  const date = String(data.date || localDate());
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date || date > localDate()) throw new Error('业务日期无效或晚于今天');
  const workOrderNo = String(data.work_order_no || '').trim();
  if (workOrderNo && cache.delivery_notes.some(note => !note.voided_at && note.work_order_no === workOrderNo)) throw new Error('送货单编号已存在，请核对');
  const freight = numberValue(data.freight === undefined ? 0 : data.freight, '运费');
  const seen = new Set();
  const prepared = data.lines.map(raw => {
    const product = getProduct(Number(raw.product_id));
    if (!product || product.deleted_at || seen.has(product.id)) throw new Error('商品不存在、已停用或重复，请核对');
    seen.add(product.id);
    const quantity = numberValue(raw.quantity, '计划数量', true);
    const delivered = numberValue(raw.delivered_qty === undefined ? quantity : raw.delivered_qty, '实收数量');
    const price = numberValue(raw.unit_price === undefined ? product.price : raw.unit_price, '单价');
    const unit = raw.unit || product.unit || '件';
    if (unit !== (product.unit || '件')) throw new Error('商品库存单位不一致');
    const specification = String(raw.specification ?? product.specification ?? '').trim();
    const [length, width] = dimensions(specification, product);
    return { product, quantity, delivered, price, unit, specification, length, width, square: roundDecimal(delivered * length * width / 1000000, 4), amount: lineAmount(delivered, price) };
  });
  return atomicMutation(() => {
    const note = { id: cache._meta.nextDeliveryNoteId++, date, work_order_no: workOrderNo, supplier_id: supplier?.id || null, supplier_name: supplier?.name || '', driver_phone: String(data.driver_phone || ''), vehicle_no: String(data.vehicle_no || ''), freight, operator: String(data.operator || ''), remark: String(data.remark || ''), lines: [], total_square_meters: 0, total_amount: 0, created_at: Date.now() };
    for (const item of prepared) {
      const result = item.delivered > 0 ? stockIn(item.product.id, item.delivered, note.operator, note.remark, note.supplier_id, { specification: item.specification, unit: item.unit, unit_price: item.price, amount: item.amount, delivery_note_id: note.id, work_order_no: workOrderNo, delivered_qty: item.delivered, square_meters: item.square }) : null;
      note.lines.push({ product_id: item.product.id, product_name: item.product.name, specification: item.specification, unit: item.unit, length: item.length, width: item.width, quantity: item.quantity, delivered_qty: item.delivered, unit_price: item.price, amount: item.amount, square_meters: item.square, ...(result ? { transaction_id: result.transaction.id } : {}) });
      note.total_square_meters += item.square; note.total_amount += item.amount;
    }
    note.total_square_meters = roundDecimal(note.total_square_meters, 4); note.total_amount = roundDecimal(note.total_amount, 2);
    if (freight > 0) systemLedger('expense', freight, null, '', null, '入库运费 · ' + (workOrderNo || note.id));
    cache.delivery_notes.push(note); persist(); return note;
  });
}
` + db.slice(end);
for (const [name, content] of [['server.js', server], ['team.js', team], ['db.js', db]]) {
  new vm.Script(content);
  fs.writeFileSync(path.join(destination, name), content);
}
for (const name of ['ai.js', 'ai-tools.js', 'ai-provider.js', 'rate-limit.js', 'list-sort.js']) {
  let content = fs.readFileSync(path.join(root, 'backend', name), 'utf8');
  // This legacy production database does not expose receipt voiding.
  if (name === 'ai-tools.js') content = content.replace("['receipt_void', '作废送货入库单', 'voidDeliveryNote'], ", '');
  new vm.Script(content); fs.writeFileSync(path.join(destination, name), content);
}
console.log('Staged AI backend with production authentication and actual-receipt billing.');
