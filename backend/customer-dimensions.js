const crypto = require('node:crypto');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function validate(raw) {
  const str = (value, limit, required = false) => {
    if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw fail('名称或规格填写不正确');
    return value.trim();
  };
  if (!raw || !Array.isArray(raw.customers) || raw.customers.length > 500) throw fail('客户资料无效');
  const ids = new Set();
  const customers = raw.customers.map(c => {
    if (!c || typeof c !== 'object') throw fail('客户资料无效');
    const id = str(c.id, 80, true);
    if (ids.has(id)) throw fail('客户编号重复'); ids.add(id);
    if (!Array.isArray(c.specs) || c.specs.length > 500) throw fail('规格资料无效');
    const specIds = new Set();
    return { id, name: str(c.name, 100, true), specs: c.specs.map(s => {
      if (!s || typeof s !== 'object') throw fail('规格资料无效');
      const specId = str(s.id, 80, true);
      if (specIds.has(specId)) throw fail('规格编号重复'); specIds.add(specId);
      return { id: specId, goods: str(s.goods, 100), size: str(s.size, 100, true), sizeUnit: str(s.sizeUnit, 10, true), material: str(s.material, 100), unit: str(s.unit, 10, true), kind: ['成品', '纸板'].includes(s.kind) ? s.kind : '成品' };
    }) };
  });
  const theme = raw.theme || {};
  const color = v => { if (typeof v !== 'string' || !/^#[a-f0-9]{6}$/i.test(v)) throw fail('颜色格式无效'); return v; };
  return { customers, theme: { title: str(theme.title, 50, true), accent: color(theme.accent), bg: color(theme.bg), card: color(theme.card) } };
}
function empty() {
  return { schemaVersion: 1, revision: 0, customers: [], theme: { title: '客户尺寸本', accent: '#468cfb', bg: '#101319', card: '#202630' } };
}
function validateDocument(raw) {
  if (!raw || (raw.schemaVersion !== undefined && raw.schemaVersion !== 1)) throw fail('客户尺寸本版本不受支持');
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) throw fail('客户尺寸本版本号无效');
  return { schemaVersion: 1, revision: raw.revision, ...validate(raw) };
}
function install(router, db) {
  const read = () => db.getCustomerDimensions();
  const route = (method, url, fn) => router[method](url, (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } });
  route('get', '/customer-dimensions', (req, res) => res.json({ success: true, data: read() }));
  route('put', '/customer-dimensions', (req, res) => {
    if (req.user.role === 'viewer') throw fail('只读账号不能修改', 403);
    // Existing clients use the dimensions revision. A key additionally lets
    // newer clients replay a successful save after losing its response.
    const key = req.get('Idempotency-Key') || crypto.randomUUID();
    if (!/^[\w-]{16,100}$/.test(key)) throw fail('提交编号格式无效');
    const fingerprint = crypto.createHash('sha256').update('PUT customer-dimensions' + JSON.stringify(req.body)).digest('hex');
    const result = db.transact(req.user, key, fingerprint, String(db.revision()), '客户尺寸本保存', () => db.updateCustomerDimensions(req.body));
    res.set('X-Warehouse-Revision', String(result.revision));
    res.json({ success: true, data: result.data });
  });
  route('post', '/customer-dimensions/order', (req, res) => {
    if (req.user.role === 'viewer') throw fail('只读账号不能开单', 403);
    const { customer_id, spec_id, quantity, unit_price } = req.body || {};
    const customer = read().customers.find(c => c.id === customer_id), spec = customer?.specs.find(s => s.id === spec_id);
    if (!customer || !spec) throw fail('客户或规格已变更，请刷新');
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isFinite(unit_price) || unit_price < 0 || unit_price > 1e8 || !Number.isSafeInteger(Math.round(quantity * unit_price * 100))) throw fail('数量或单价不正确');
    const key = req.get('Idempotency-Key'); if (!key) throw fail('缺少提交编号');
    const fingerprint = crypto.createHash('sha256').update('customer-dimensions/order' + JSON.stringify(req.body)).digest('hex');
    const result = db.transact(req.user, key, fingerprint, req.get('If-Match'), '客户尺寸本开单', () => {
      const matches = db.listCustomers().filter(c => c.name === customer.name && !c.deleted_at);
      if (matches.length > 1) throw fail('同名客户有多个，请先在客户资料中核对');
      const party = matches[0] || db.addCustomer({ name: customer.name });
      return db.addOrder({ order_no: 'KH' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), customer_id: party.id, customer_name: party.name, specification: spec.size + ' ' + spec.sizeUnit, material: spec.material, quantity, unit: spec.unit, unit_price, status: '生产中', remark: spec.goods });
    });
    res.set('X-Warehouse-Revision', String(result.revision)); res.json({ success: true, data: result.data });
  });
}
module.exports = { install, validate, validateDocument, empty };
