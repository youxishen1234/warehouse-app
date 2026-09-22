const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const roles = ['admin', 'operator', 'viewer'];
const DEFAULT_GATE_PASSWORD = 'shuguang2026';
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const clean = user => ({ id: user.id, username: user.username, role: user.role, disabled: !!user.disabled });
const error = (message, status = 400) => Object.assign(new Error(message), { status });
async function passwordHash(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw error('密码须为 12 至 128 位');
  return (await scrypt(password, salt, 64)).toString('hex');
}
function save(file, value) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
async function bootstrap(file, password) {
  if (fs.existsSync(file)) throw error('账号文件已存在，禁止覆盖');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await passwordHash(password, salt);
  fs.writeFileSync(file, JSON.stringify({ users: [{ id: crypto.randomUUID(), username: 'admin', role: 'admin', salt, hash, disabled: false }], events: [] }, null, 2), { flag: 'wx', mode: 0o600 });
}
function install(db) {
  const router = require('express').Router();
  const file = process.env.WAREHOUSE_ACCOUNTS_FILE || path.join(__dirname, 'accounts.json');
  let accounts = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(accounts.users) || !accounts.users.some(u => u.role === 'admin' && !u.disabled)) throw error('缺少管理员账号');
  const sessions = new Map(), attempts = new Map();
  const gateFile = process.env.WAREHOUSE_GATE_PASSWORD_FILE || path.join(__dirname, 'access-password');
  const gatePassword = () => { try { return fs.readFileSync(gateFile, 'utf8').trim() || DEFAULT_GATE_PASSWORD; } catch { return DEFAULT_GATE_PASSWORD; } };
  const accountCommit = (actor, operation, change) => {
    const active = accounts.users.find(u => u.id === actor.id && !u.disabled);
    if (!active || (operation !== '修改密码' && active.role !== 'admin')) throw error('账号权限已变更，请重新登录', 403);
    const next = JSON.parse(JSON.stringify(accounts));
    const result = change(next);
    if (!next.users.some(u => u.role === 'admin' && !u.disabled)) throw error('必须保留至少一个启用的管理员');
    next.events.push({ actor_name: actor.username, operation, time: Date.now() });
    save(file, next); accounts = next; return result;
  };
  const ok = (res, data) => res.json({ success: true, data });
  const route = (method, url, handler) => router[method](url, (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Warehouse-Revision', String(db.revision())); next(); });
  route('get', '/health', (req, res) => ok(res, { online: true, authentication: true }));
  route('post', '/auth/login', async (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    for (const [key, attempt] of attempts) if (attempt.until < now) attempts.delete(key);
    const attempt = attempts.get(ip) || { count: 0, until: now + 600000 };
    if (++attempt.count > 20) throw error('尝试过于频繁，请十分钟后重试', 429);
    attempts.set(ip, attempt);
    const { username, password } = req.body || {};
    const user = accounts.users.find(u => u.username === username && !u.disabled);
    const hash = await passwordHash(password, user?.salt || 'invalid-user-salt');
    if (!user || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'))) throw error('账号或密码错误', 401);
    if (!accounts.users.some(u => u.id === user.id && !u.disabled && u.hash === user.hash)) throw error('账号已变更，请重试', 401);
    attempts.delete(ip);
    for (const [key, session] of sessions) if (session.expires < now) sessions.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(digest(token), { userId: user.id, expires: now + 12 * 3600000 });
    ok(res, { token, user: clean(user), expires: now + 12 * 3600000 });
  });
  route('post', '/auth/gate', (req, res) => {
    if (!req.body || req.body.password !== gatePassword()) throw error('访问密码错误', 401);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(digest(token), { userId: `gate:${crypto.randomUUID()}`, gate: true, expires: Date.now() + 12 * 3600000 });
    ok(res, { token, user: { id: 'shared', username: '共享用户', role: 'operator', gate: true, disabled: false }, expires: Date.now() + 12 * 3600000 });
  });
  // App 启动时使用无感共享会话，不再向用户展示访问密码页面。
  route('post', '/auth/guest', (req, res) => {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(digest(token), { userId: `guest:${crypto.randomUUID()}`, gate: true, expires: Date.now() + 12 * 3600000 });
    ok(res, { token, user: { id: 'guest', username: '共享用户', role: 'operator', gate: true, disabled: false }, expires: Date.now() + 12 * 3600000 });
  });
  router.use((req, res, next) => {
    if ((req.method === 'GET' && ['/appupdate/check', '/app/downloads'].includes(req.path)) || (req.method === 'POST' && req.path === '/appupdate/report')) return next('router');
    const key = digest(String(req.get('Authorization') || '').replace(/^Bearer /, ''));
    const session = sessions.get(key);
    const user = session && session.expires > Date.now() && (session.gate ? { id: session.userId, username: '共享用户', role: 'operator', gate: true, disabled: false } : accounts.users.find(u => u.id === session.userId && !u.disabled));
    if (!user) {
      if (/^\/(team|audit|auth)/.test(req.path)) return next(error('请登录后使用', 401));
      return next(error('请输入共享访问密码', 401));
    }
    req.user = user; req.sessionKey = key; next();
  });
  route('get', '/auth/me', (req, res) => ok(res, clean(req.user)));
  route('post', '/auth/logout', (req, res) => { sessions.delete(req.sessionKey); ok(res, true); });
  route('post', '/auth/password', async (req, res) => {
    const oldHash = await passwordHash(req.body.currentPassword, req.user.salt);
    if (oldHash !== req.user.hash) throw error('当前密码不正确');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await passwordHash(req.body.password, salt);
    accountCommit(req.user, '修改密码', next => { const u = next.users.find(u => u.id === req.user.id); u.salt = salt; u.hash = hash; });
    for (const [key, s] of sessions) if (s.userId === req.user.id) sessions.delete(key);
    ok(res, true);
  });
  router.use(['/team', '/audit'], (req, res, next) => req.user.role === 'admin' ? next() : next(error('仅管理员可操作', 403)));
  route('get', '/team', (req, res) => ok(res, accounts.users.map(clean)));
  route('post', '/team', async (req, res) => {
    const { username, password, role } = req.body;
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username) || !roles.includes(role)) throw error('账号须为 3 至 32 位字母、数字或下划线，角色无效');
    const salt = crypto.randomBytes(16).toString('hex'), hash = await passwordHash(password, salt);
    const user = { id: crypto.randomUUID(), username, role, salt, hash, disabled: false };
    accountCommit(req.user, `创建账号 ${username}`, next => { if (next.users.some(u => u.username === username)) throw error('账号已存在'); next.users.push(user); });
    ok(res, clean(user));
  });
  route('put', '/team/:id', async (req, res) => {
    const { role, disabled, password } = req.body;
    if (role !== undefined && !roles.includes(role)) throw error('角色无效');
    if (disabled !== undefined && typeof disabled !== 'boolean') throw error('启用状态无效');
    let salt, hash;
    if (password !== undefined) { salt = crypto.randomBytes(16).toString('hex'); hash = await passwordHash(password, salt); }
    const user = accountCommit(req.user, `更新账号 ${req.params.id}`, next => {
      const u = next.users.find(u => u.id === req.params.id); if (!u) throw error('账号不存在', 404);
      if (role !== undefined) u.role = role; if (disabled !== undefined) u.disabled = disabled;
      if (hash) { u.salt = salt; u.hash = hash; } return clean(u);
    });
    for (const [key, s] of sessions) if (s.userId === req.params.id) sessions.delete(key);
    ok(res, user);
  });
  route('get', '/audit', (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const all = [...db.audit(), ...accounts.events].sort((a,b) => b.time-a.time);
    ok(res, { total: all.length, items: all.slice((page-1)*50,page*50) });
  });
  route('get', '/sync', (req, res) => ok(res, { revision: db.revision() }));
  route('get', '/orders/:id/events', (req, res) => ok(res, db.listOrderEvents(Number(req.params.id))));
  route('get', '/export/transactions.csv', (req, res) => {
    const rows = [['时间','类型','商品','规格','材质','数量','单位','单价','金额','客户','供应商','备注']];
    for (const t of db.listTx(req.query)) rows.push([new Date(t.created_at).toISOString(),t.type,t.product_name||'',t.specification||'',t.material||'',t.quantity||0,t.unit||'',t.unit_price||0,t.amount||0,t.customer_name||'',t.supplier_name||'',t.remark||'']);
    res.type('text/csv').send('\ufeff' + rows.map(row => row.map(v => `"${String(v).replaceAll('"','""')}"`).join(',')).join('\r\n'));
  });
  route('get', '/export/ledger.csv', (req, res) => {
    const rows = [['时间','类型','金额','往来对象','说明']];
    for (const x of db.listLedger(req.query)) rows.push([new Date(x.created_at).toISOString(),x.type,x.amount,x.party_name||'',x.remark||'']);
    res.type('text/csv').send('\ufeff' + rows.map(row => row.map(v => `"${String(v).replaceAll('"','""')}"`).join(',')).join('\r\n'));
  });
  route('post', '/stocktake', (req, res) => { if (req.user.role === 'viewer') throw error('只读账号不能盘点',403); const key=req.get('Idempotency-Key'); if(!key) throw error('缺少提交编号'); const result=db.transact(req.user,key,digest(JSON.stringify(req.body)),req.get('If-Match'), 'POST /stocktake',()=>db.addStocktake(req.body)); res.set('X-Warehouse-Revision',String(result.revision)); ok(res,result.data); });
  route('get', '/stocktakes', (req, res) => ok(res, db.listStocktakes(req.query)));
  route('get', '/delivery-notes', (req, res) => ok(res, db.listDeliveryNotes()));
  route('get', '/delivery-notes/:id', (req, res) => { const note=db.getDeliveryNote(Number(req.params.id)); if(!note) throw error('送货单不存在',404); ok(res,note); });
  route('get', '/delivery-notes/:id.csv', (req, res) => { const note=db.getDeliveryNote(Number(req.params.id)); if(!note) throw error('送货单不存在',404); const rows=[['日期',note.date],['工单编号/采购单号',note.work_order_no],['供应商',note.supplier_name],['司机电话',note.driver_phone],['车号',note.vehicle_no],['运费',note.freight],[],['规格/楞别','数量(张)','单价(元/张)','送货数','平米数','金额']]; for(const line of note.lines)rows.push([line.specification,line.quantity,line.unit_price,line.delivered_qty,line.square_meters,line.amount]); rows.push(['合计','','','','',note.total_amount],['总平米',note.total_square_meters],['备注',note.remark]); res.type('text/csv').send('\ufeff'+rows.map(row=>row.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\r\n')); });
  route('post', '/delivery-notes', (req, res) => { if(req.user.role==='viewer') throw error('只读账号不能保存送货单',403); const key=req.get('Idempotency-Key'); if(!key) throw error('缺少提交编号'); const result=db.transact(req.user,key,digest(JSON.stringify(req.body)),req.get('If-Match'),'POST /delivery-notes',()=>db.addDeliveryNote(req.body)); res.set('X-Warehouse-Revision',String(result.revision)); ok(res,result.data); });
  route('post', '/sync/upload', (req, res) => ok(res, { ok: true, received: true }));
  route('post', '/products/:id/image', (req, res) => {
    if (req.user.role === 'viewer') throw error('只读账号不能上传图片', 403);
    const raw = String(req.body?.data || '');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(raw);
    if (!match) throw error('仅支持 PNG、JPEG 或 WebP 图片');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw error('图片大小不能超过 2 MiB');
    const product = db.getProduct(Number(req.params.id)); if (!product) throw error('商品不存在',404);
    const uploadDir = path.join(__dirname, 'public', 'uploads', 'products'); fs.mkdirSync(uploadDir, { recursive: true });
    const ext = match[1].split('/')[1].replace('jpeg','jpg'); const name = `${product.id}-${crypto.randomBytes(8).toString('hex')}.${ext}`; const target = path.join(uploadDir,name); const temp = `${target}.tmp`;
    fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o644 }); fs.renameSync(temp, target);
    const key = req.get('Idempotency-Key'); if (!key) throw error('缺少提交编号');
    const result = db.transact(req.user, key, digest(product.id + name), req.get('If-Match'), `POST /products/${product.id}/image`, () => db.updateProduct(product.id, { image_url: `/uploads/products/${name}` }));
    res.set('X-Warehouse-Revision', String(result.revision)); ok(res, result.data);
  });
  const collections = { products: ['listProducts','getProduct','addProduct','updateProduct','deleteProduct'], customers: ['listCustomers','getCustomer','addCustomer','updateCustomer','deleteCustomer'], suppliers: ['listSuppliers','getSupplier','addSupplier','updateSupplier','deleteSupplier'], orders: ['listOrders',null,'addOrder','updateOrder'], transactions: ['listTx',null,null,null,'deleteTransaction'], ledger: ['listLedger',null,'addLedger',null,'deleteLedger'] };
  route('get', '/stats', (req,res) => ok(res, db.stats()));
  router.use((req, res, next) => {
    try {
      const match = /^\/(products|customers|suppliers|orders|transactions|ledger)(?:\/(\d+))?\/?$/.exec(req.path);
      const stock = /^\/stock\/(in|out)$/.exec(req.path);
      if (!match && !stock) throw error('接口不存在', 404);
      const body = req.body || {}, collection = match?.[1], id = match?.[2] ? Number(match[2]) : null;
      if (req.method === 'GET' && match) {
        const names = collections[collection]; const data = id ? (names[1] ? db[names[1]](id) : db[names[0]]({}).find(row=>row.id===id)) : db[names[0]](req.query);
        if (!data) throw error('记录不存在', 404); return ok(res, data);
      }
      if (req.user.role === 'viewer') throw error('只读账号不能修改数据', 403);
      if (req.user.role !== 'admin' && !req.user.gate && (req.method !== 'POST' || collection === 'ledger' || ['debt','payable'].some(k => Number(body[k]) !== 0 && body[k] !== undefined))) throw error('编辑、删除、账务和结清需要管理员权限', 403);
      const key = req.get('Idempotency-Key');
      if (!key || !/^[\w-]{16,100}$/.test(key)) throw error('缺少有效的提交编号');
      for (const name of ['quantity','stock','price','unit_price','debt','payable','amount','safety_stock']) if (body[name] !== undefined && (body[name] === null || body[name] === '' || !Number.isFinite(Number(body[name])) || Number(body[name]) < 0)) throw error('金额和数量必须是有效非负数');
      if (stock && !(Number(body.quantity) > 0)) throw error('数量必须大于零');
      const payload = { ...body };
      delete payload.id; delete payload.created_at; delete payload.updated_at;
      if (collection === 'orders') {
        for (const key of Object.keys(payload)) if (!['order_no','customer_id','customer_name','specification','material','quantity','unit','unit_price','delivery_date','status','remark'].includes(key)) delete payload[key];
        if (payload.status !== undefined && !['待生产','生产中','已发货','已完成'].includes(payload.status)) throw error('订单状态无效');
      }
      const operation = `${req.method} ${req.path}`;
      const result = db.transact(req.user, key, digest(operation + JSON.stringify(payload)), req.get('If-Match'), operation, () => {
        if (collection === 'orders' && req.method === 'POST' && db.listOrders().some(o => o.order_no === String(payload.order_no || '').trim())) throw error('订单号已存在', 409);
        if (stock && req.method === 'POST') return db[stock[1] === 'in' ? 'stockIn' : 'stockOut'](Number(payload.product_id), Number(payload.quantity), req.user.username, payload.remark || '', stock[1] === 'in' ? payload.supplier_id : payload.customer_id, payload);
        const names = collections[collection] || [];
        const method = req.method === 'POST' && !id ? names[2] : req.method === 'PUT' && id ? names[3] : req.method === 'DELETE' && id ? names[4] : null;
        if (!method) throw error('不支持的操作', 405);
        return req.method === 'POST' ? db[method](payload) : db[method](id, payload);
      });
      res.set('X-Warehouse-Revision', String(result.revision));
      ok(res, result.data);
    } catch (e) { next(e); }
  });
  router.use((e, req, res, next) => res.status(e.status || 400).json({ success: false, message: e.message }));
  return router;
}
module.exports = install;
module.exports.bootstrap = bootstrap;
