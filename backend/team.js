const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ORDER_STATUSES, validateSortQuery, sortList } = require('./list-sort');
const { parseDateQuery } = require('./date-query');
const updates = require('./updates');
const { consumeRateLimit } = require('./rate-limit');
const hotUpdateStatsRateLimit = () => Math.max(2, Math.min(1000, Number(process.env.WAREHOUSE_HOTUPDATE_STATS_RATE_LIMIT) || 60));

const scrypt = promisify(crypto.scrypt);
const roles = ['admin', 'operator', 'viewer'];
const DEFAULT_GATE_PASSWORD = 'shuguang2026';
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const productImagePath = imageUrl => {
  if (typeof imageUrl !== 'string') return null;
  const match = /^\/uploads\/products\/([A-Za-z0-9._-]+)$/.exec(imageUrl);
  if (!match) return null;
  const root = path.resolve(__dirname, 'public', 'uploads', 'products');
  const target = path.resolve(root, match[1]);
  return target.startsWith(root + path.sep) ? target : null;
};
const validImageBytes = (mime, bytes) => {
  if (mime === 'image/png') return bytes.length >= 8 && Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).equals(bytes.subarray(0, 8));
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
};
const csvCell = value => {
  const text = String(value ?? '');
  const safe = typeof value === 'string' && /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};
async function* csvRows(headings, rows, toCells) {
  yield `\ufeff${headings.map(csvCell).join(',')}\r\n`;
  let index = 0;
  for (const row of rows) {
    yield `${toCells(row).map(csvCell).join(',')}\r\n`;
    index += 1;
    // Let other requests run during long exports without changing row order
    // or the response format. Backpressure still controls the stream itself.
    if (index % 256 === 0) await new Promise(resolve => setImmediate(resolve));
  }
}
async function streamCsv(res, headings, rows, toCells) {
  res.type('text/csv');
  const source = Readable.from(csvRows(headings, rows, toCells));
  await pipeline(source, res);
}
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
  const statsBuckets = new Map();
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
  router.use((req, res, next) => {
    const requestId = req.get('X-Request-Id') || crypto.randomUUID();
    res.set({
      'Cache-Control': 'no-store',
      'X-Warehouse-Revision': String(db.revision()),
      'X-Request-Id': requestId,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    next();
  });
  route('get', '/health', (req, res) => ok(res, { ...db.health(), authentication: true, accountsAvailable: fs.existsSync(file) }));
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
  const rateBuckets = new Map();
  const rateLimit = (req, scope, limit, windowMs) => {
    const source = `${req.warehouseClientIp || req.ip}|${String(req.get('X-Warehouse-Device') || 'unknown').slice(0, 80)}`;
    const bucketKey = `${scope}:${source}`;
    return consumeRateLimit(rateBuckets, bucketKey, { limit, windowMs });
  };
  router.use((req, res, next) => {
    const exportRequest = req.method === 'GET' && (/\.csv$/.test(req.path) || req.path === '/backup');
    const writeRequest = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if ((writeRequest && !rateLimit(req, 'write', Math.max(20, Number(process.env.WAREHOUSE_WRITE_RATE_LIMIT) || 300), 60000)) ||
      (exportRequest && !rateLimit(req, 'export', Math.max(2, Number(process.env.WAREHOUSE_EXPORT_RATE_LIMIT) || 20), 60000))) {
      res.set('Retry-After', '60');
      return next(error('操作过于频繁，请稍后重试', 429));
    }
    next();
  });
  route('get', '/auth/me', (req, res) => ok(res, clean(req.user)));
  route('post', '/auth/logout', (req, res) => { sessions.delete(req.sessionKey); ok(res, true); });
  // Keep the hot-update dashboard behind the authenticated router. Defining
  // it here avoids the router's unknown-route guard swallowing this endpoint
  // before a later server-level handler can run.
  route('get', '/appupdate/stats', (req, res) => {
    const bucketKey = `${req.warehouseClientIp || req.ip || 'unknown'}:${String(req.get('X-Warehouse-Device') || 'unknown').slice(0, 80)}`;
    if (!consumeRateLimit(statsBuckets, bucketKey, { limit: hotUpdateStatsRateLimit() })) {
      res.set('Retry-After', '60');
      throw error('热更新统计请求过于频繁，请稍后重试', 429);
    }
    ok(res, updates.stats(updates.parseRecent(req.query.recent)));
  });
  route('post', '/auth/password', async (req, res) => {
    const oldHash = await passwordHash(req.body.currentPassword, req.user.salt);
    if (oldHash !== req.user.hash) throw error('当前密码不正确');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await passwordHash(req.body.password, salt);
    accountCommit(req.user, '修改密码', next => { const u = next.users.find(candidate => candidate.id === req.user.id); u.salt = salt; u.hash = hash; });
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
      const u = next.users.find(candidate => candidate.id === req.params.id); if (!u) throw error('账号不存在', 404);
      if (role !== undefined) u.role = role; if (disabled !== undefined) u.disabled = disabled;
      if (hash) { u.salt = salt; u.hash = hash; } return clean(u);
    });
    for (const [key, s] of sessions) if (s.userId === req.params.id) sessions.delete(key);
    ok(res, user);
  });
  route('get', '/audit', (req, res) => {
    const rawPage = req.query.page;
    if (rawPage !== undefined && (typeof rawPage !== 'string' || !/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage)))) {
      throw error('page ??????', 400);
    }
    const page = rawPage === undefined ? 1 : Number(rawPage);
    const all = [...db.audit(), ...accounts.events].sort((a,b) => b.time-a.time);
    const offset = (page - 1) * 50;
    const items = Number.isSafeInteger(offset) && Number.isSafeInteger(offset + 50) ? all.slice(offset, offset + 50) : [];
    ok(res, { total: all.length, items });
  });
  route('get', '/sync', (req, res) => {
    const current = String(db.revision());
    // The revision is a strong validator for the shared dataset. A client that
    // already has this revision receives an empty 304 response.
    res.set('ETag', `"${current}"`);
    const ifNoneMatch = String(req.get('If-None-Match') || '').split(',').map(value => value.trim()).filter(Boolean);
    if (ifNoneMatch.includes(`"${current}"`) || ifNoneMatch.includes('*')) return res.status(304).end();
    return ok(res, { revision: Number(current) });
  });
  route('get', '/sync/receipt/:key', (req, res) => {
    const key = String(req.params.key || '');
    if (!/^[\w-]{16,100}$/.test(key)) throw error('提交编号格式无效');
    const item = db.receipt(req.user.id, key);
    if (!item) return res.status(404).json({ success: false, message: '未找到提交回执' });
    res.set('X-Warehouse-Revision', String(db.revision()));
    return ok(res, { data: item.data, revision: db.revision(), replayed: true });
  });
  route('get', '/orders/:id/events', (req, res) => {
    validateListQuery(req.query, 'order_events');
    return ok(res, paginateList(sortList(db.listOrderEvents(Number(req.params.id)), req.query, 'order_events'), req.query));
  });
  route('get', '/delivery-notes/:id.csv', (req, res) => {
    const note = db.getDeliveryNote(Number(req.params.id)); if (!note) throw error('送货单不存在', 404);
    const rows = [['状态', note.voided_at ? '已作废' : '已入库'], ['日期', note.date], ['工单编号/采购单号', note.work_order_no], ['供应商', note.supplier_name], ['操作人', note.operator || ''], ['司机电话', note.driver_phone], ['车号', note.vehicle_no], ['运费（单独记录，不计入货款应付）', note.freight], [], ['商品', '规格/楞别', '单位', '计划数量', '单价', '实际入库数量', '平米数', '货款金额']];
    for (const line of note.lines) rows.push([line.product_name, line.specification, line.unit || '', line.quantity, line.unit_price, line.delivered_qty, line.square_meters, line.amount]);
    rows.push(['货款合计', '', '', '', '', '', '', note.total_amount], ['总平米', note.total_square_meters], ['备注', note.remark]);
    res.attachment(`delivery-note-${note.id}.csv`).type('text/csv').send('\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'));
  });
  route('get', '/backup', (req, res) => { if (req.user.role === 'viewer') throw error('只读账号不能导出备份',403); ok(res, { exportedAt: new Date().toISOString(), data: db.backupData() }); });
  route('post', '/backup', (req, res) => { if (req.user.role === 'viewer') throw error('只读账号不能恢复备份',403); const key=req.get('Idempotency-Key'); if(!key || !/^[\w-]{16,100}$/.test(key)) throw error('缺少有效的提交编号'); const payload=req.body?.data || req.body; const result=db.transact(req.user,key,digest(JSON.stringify(payload)),req.get('If-Match'),'POST /backup',()=>db.restoreData(payload)); res.set('X-Warehouse-Revision',String(result.revision)); ok(res,result.data); });
  route('post', '/stock/out/batch', (req, res) => { if (req.user.role === 'viewer') throw error('只读账号不能出库',403); const key=req.get('Idempotency-Key'); if(!key || !/^[\w-]{16,100}$/.test(key)) throw error('缺少有效的提交编号'); const body=req.body||{}; const result=db.transact(req.user,key,digest('POST /stock/out/batch'+JSON.stringify(body)),req.get('If-Match'),'POST /stock/out/batch',()=>({ transactions: db.stockOutBatch(body.lines,body.operator||req.user.username,body.remark||'',body.customer_id) })); res.set('X-Warehouse-Revision',String(result.revision)); ok(res,result.data); });
  route('get', '/export/transactions.csv', async (req, res) => {
    validateListQuery(req.query, 'transactions');
    const rows = sortList(db.listTx(req.query), req.query, 'transactions');
    if (!rows.length) throw error('没有符合条件的流水可导出', 404);
    await streamCsv(res, ['时间','类型','商品','规格','材质','数量','单位','单价','金额','客户','供应商','备注','状态'], rows, t => [new Date(t.created_at).toISOString(),t.type,t.product_name||'',t.specification||'',t.material||'',t.type === 'adjustment' ? t.adjustment : t.quantity||0,t.unit||'',t.unit_price||0,t.amount||0,t.customer_name||'',t.supplier_name||'',t.remark||'',t.voided_at ? '已作废（不计库存及金额）' : '有效']);
  });
  route('get', '/export/ledger.csv', async (req, res) => {
    validateListQuery(req.query, 'ledger');
    const rows = sortList(db.listLedger(req.query), req.query, 'ledger');
    if (!rows.length) throw error('没有符合条件的账本流水可导出', 404);
    await streamCsv(res, ['时间','类型','金额','往来对象','说明'], rows, x => [new Date(x.created_at).toISOString(),x.type,x.amount,x.party_name||'',x.remark||'']);
  });
  route('post', '/stocktake', (req, res) => { if (req.user.role === 'viewer') throw error('只读账号不能盘点',403); const key=req.get('Idempotency-Key'); if(!key || !/^[\w-]{16,100}$/.test(key)) throw error('缺少有效的提交编号'); const result=db.transact(req.user,key,digest(JSON.stringify(req.body)),req.get('If-Match'), 'POST /stocktake',()=>db.addStocktake(req.body)); res.set('X-Warehouse-Revision',String(result.revision)); ok(res,result.data); });
  route('get', '/stocktakes', (req, res) => { validateListQuery(req.query, 'stocktakes'); return ok(res, paginateList(sortList(db.listStocktakes(req.query), req.query, 'stocktakes'), req.query)); });
  route('get', '/delivery-notes', (req, res) => { validateListQuery(req.query, 'delivery_notes'); return ok(res, paginateList(sortList(db.listDeliveryNotes(), req.query, 'delivery_notes'), req.query)); });
  route('get', '/delivery-notes/:id', (req, res) => { const note=db.getDeliveryNote(Number(req.params.id)); if(!note) throw error('送货单不存在',404); ok(res,note); });
  route('post', '/delivery-notes', (req, res) => {
    if (req.user.role === 'viewer') throw error('只读账号不能保存送货单', 403);
    const remark = req.body?.remark;
    if (remark !== undefined && (typeof remark !== 'string' || remark.length > 500)) throw error('remark 长度不能超过 500 个字符且必须为文本');
    const key = req.get('Idempotency-Key');
    if (!key || !/^[\w-]{16,100}$/.test(key)) throw error('缺少有效的提交编号');
    const result = db.transact(req.user, key, digest('POST /delivery-notes' + JSON.stringify(req.body)), req.get('If-Match'), 'POST /delivery-notes', () => db.addDeliveryNote({ ...req.body, operator: req.body.operator || req.user.username }));
    res.set('X-Warehouse-Revision', String(result.revision));
    ok(res, result.data);
  });
  route('delete', '/delivery-notes/:id', (req, res) => {
    if (req.user.role !== 'admin' && !req.user.gate) throw error('作废需要管理员权限', 403);
    const key = req.get('Idempotency-Key'); if (!key || !/^[\w-]{16,100}$/.test(key)) throw error('缺少有效的提交编号');
    const operation = `DELETE /delivery-notes/${req.params.id}`;
    const result = db.transact(req.user, key, digest(operation), req.get('If-Match'), operation, () => db.voidDeliveryNote(Number(req.params.id)));
    res.set('X-Warehouse-Revision', String(result.revision)); ok(res, result.data);
  });
  route('post', '/sync/upload', (req, res) => ok(res, { ok: true, received: true }));
  route('post', '/products/:id/image', (req, res) => {
    const key = req.get('Idempotency-Key');
    if (!key || !/^[\w-]{16,100}$/.test(key)) throw error('缺少有效的提交编号');
    if (req.user.role === 'viewer') throw error('只读账号不能上传图片', 403);
    const raw = String(req.body?.data || '');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(raw);
    if (!match) throw error('仅支持 PNG、JPEG 或 WebP 图片');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw error('图片大小不能超过 2 MiB');
    if (!validImageBytes(match[1], bytes)) throw error('图片内容与文件类型不一致，请重新上传');
    const product = db.getProduct(Number(req.params.id)); if (!product) throw error('商品不存在',404);
    const uploadDir = path.join(__dirname, 'public', 'uploads', 'products'); fs.mkdirSync(uploadDir, { recursive: true });
    const ext = match[1].split('/')[1].replace('jpeg','jpg');
    // Content-addressed names make retries reuse the same file and avoid orphan uploads.
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
    const name = `${product.id}-${contentHash}.${ext}`;
    const target = path.join(uploadDir, name);
    const temp = `${target}.tmp-${process.pid}`;
    const imageUrl = `/uploads/products/${name}`;
    const oldImage = product.image_url;
    let created = false;
    try {
      if (!fs.existsSync(target)) {
        fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o644 });
        fs.renameSync(temp, target);
        created = true;
      }
      const result = db.transact(req.user, key, digest(`${product.id}:${match[1]}:${contentHash}`), req.get('If-Match'), `POST /products/${product.id}/image`, () => db.updateProduct(product.id, { image_url: imageUrl }));
      if (oldImage && oldImage !== imageUrl) {
        const oldPath = productImagePath(oldImage);
        if (oldPath && oldPath !== target) { try { fs.unlinkSync(oldPath); } catch (fileError) { if (fileError.code !== 'ENOENT') console.warn('[upload] failed to remove old image', fileError.message); } }
      }
      res.set('X-Warehouse-Revision', String(result.revision)); ok(res, result.data);
    } catch (uploadError) {
      if (created) { try { fs.unlinkSync(target); } catch (fileError) { if (fileError.code !== 'ENOENT') console.warn('[upload] failed to clean image', fileError.message); } }
      try { fs.unlinkSync(temp); } catch (fileError) { if (fileError.code !== 'ENOENT') console.warn('[upload] failed to clean temp image', fileError.message); }
      throw uploadError;
    }
  });
  const queryString = (query, name) => {
    const value = query[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 200) throw error(`查询参数 ${name} 必须是长度不超过 200 的文本`);
    return value;
  };
  const queryPositiveId = (query, name) => {
    const value = queryString(query, name);
    if (value === undefined) return;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw error(`查询参数 ${name} 必须是有效正整数`);
  };
  const validateListQuery = (query, collection) => {
    queryString(query, 'sort'); queryString(query, 'order');
    validateSortQuery(query, collection);
    for (const name of ['product_id', 'customer_id', 'supplier_id', 'page', 'page_size']) queryPositiveId(query, name);
    const pageSize = queryString(query, 'page_size');
    if (pageSize !== undefined && Number(pageSize) > 500) throw error('每页数量 page_size 不能超过 500');
    const dateBounds = {};
    for (const name of ['from', 'to']) {
      const value = queryString(query, name);
      if (value !== undefined) {
        try { dateBounds[name] = parseDateQuery(value, name === 'to'); }
        catch (cause) { throw error(`查询参数 ${name} 必须是有效的毫秒时间戳或 YYYY-MM-DD`); }
      }
    }
    const keyword = queryString(query, 'keyword');
    if (keyword !== undefined && keyword.length > 100) throw error('搜索关键词不能超过 100 个字符');
    const includeVoided = queryString(query, 'include_voided');
    if (includeVoided !== undefined && !['true', 'false'].includes(includeVoided)) throw error('查询参数 include_voided 只能是 true 或 false');
    const type = queryString(query, 'type');
    if (type !== undefined) {
      const allowed = collection === 'ledger' ? ['income', 'expense', 'receivable', 'payable', 'settlement'] : collection === 'transactions' ? ['in', 'out', 'adjustment'] : [];
      if (!allowed.includes(type)) throw error(`查询类型无效${allowed.length ? `，允许值：${allowed.join('、')}` : '，此列表不支持 type 筛选'}`);
    }
    const status = queryString(query, 'status');
    if (status !== undefined) {
      if (collection !== 'orders') throw error('此列表不支持 status 筛选');
      if (!ORDER_STATUSES.includes(status)) throw error(`订单状态无效，允许值：${ORDER_STATUSES.join('、')}`);
    }
    if (dateBounds.from !== undefined && dateBounds.to !== undefined) {
      try {
        // Compare the parsed instants; YYYY-MM-DD bounds already include the
        // local end of day while numeric timestamps retain legacy semantics.
        if (parseDateQuery(query.from) > parseDateQuery(query.to)) throw error('开始日期不能晚于结束日期');
      } catch (cause) {
        if (cause.status) throw cause;
        throw error('日期范围无效');
      }
    }
  };
  const paginateList = (rows, query) => {
    if (!Array.isArray(rows) || query.page === undefined && query.page_size === undefined) return rows;
    const page = Number(query.page || 1);
    const pageSize = Number(query.page_size || 100);
    const offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + pageSize)) throw error('页码超出支持范围，请缩小页码后重试');
    return { items: rows.slice(offset, offset + pageSize), total: rows.length, page, page_size: pageSize };
  };
  const validateWriteBody = (req, body) => {
    if (!['POST', 'PUT'].includes(req.method)) return;
    if (!req.is('application/json') || !body || typeof body !== 'object' || Array.isArray(body)) throw error('请求体必须是 JSON 对象');
    const limits = { name: 50, username: 32, order_no: 50, category: 50, specification: 100, material: 100, corrugation: 100, remark: 500, settlement_remark: 500, operator: 50, work_order_no: 50, driver_phone: 20, vehicle_no: 20, contact: 50, phone: 20, address: 200 };
    for (const [field, limit] of Object.entries(limits)) {
      if (body[field] !== undefined && typeof body[field] === 'string' && body[field].length > limit) throw error(`${field} 长度不能超过 ${limit} 个字符`);
      if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string' && field in body) throw error(`${field} 必须是文本`);
    }
    for (const field of ['phone', 'driver_phone']) {
      if (body[field] !== undefined && body[field] !== '' && !/^[0-9+()\-\s]{5,20}$/.test(String(body[field]))) throw error(`${field} 格式无效`);
    }
    if (body.lines !== undefined && (!Array.isArray(body.lines) || body.lines.length === 0)) throw error('lines 至少需要一行');
    if (Array.isArray(body.lines)) body.lines.forEach((line, index) => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) throw error(`第 ${index + 1} 行明细格式无效`);
      if (line.product_id === undefined || line.quantity === undefined && line.delivered_qty === undefined) throw error(`第 ${index + 1} 行缺少商品或数量`);
    });
  };
  const collections = { products: ['listProducts','getProduct','addProduct','updateProduct','deleteProduct'], customers: ['listCustomers','getCustomer','addCustomer','updateCustomer','deleteCustomer'], suppliers: ['listSuppliers','getSupplier','addSupplier','updateSupplier','deleteSupplier'], orders: ['listOrders',null,'addOrder','updateOrder'], transactions: ['listTx',null,null,null,'deleteTransaction'], ledger: ['listLedger',null,'addLedger',null,'deleteLedger'] };
  route('get', '/stats', (req,res) => ok(res, db.stats()));
  router.use((req, res, next) => {
    try {
      const match = /^\/(products|customers|suppliers|orders|transactions|ledger)(?:\/(\d+))?\/?$/.exec(req.path);
      const stock = /^\/stock\/(in|out)$/.exec(req.path);
      if (!match && !stock) throw error('接口不存在', 404);
      const body = req.body || {}, collection = match?.[1], id = match?.[2] ? Number(match[2]) : null;
      validateWriteBody(req, body);
      if (req.method === 'GET' && match) {
        if (!id) validateListQuery(req.query, collection);
        const names = collections[collection]; const rawData = id ? (names[1] ? db[names[1]](id) : db[names[0]]({}).find(row=>row.id===id)) : db[names[0]](req.query);
        const data = id ? rawData : paginateList(sortList(rawData, req.query, collection), req.query);
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
        for (const field of Object.keys(payload)) if (!['order_no','customer_id','customer_name','specification','material','quantity','unit','unit_price','delivery_date','status','remark'].includes(field)) delete payload[field];
        if (payload.status !== undefined && !ORDER_STATUSES.includes(payload.status)) throw error(`订单状态无效，允许值：${ORDER_STATUSES.join('、')}`);
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
  router.use((e, req, res, next) => { // eslint-disable-line no-unused-vars -- Express requires four parameters to recognize error middleware.
    // Database domain rules historically throw plain Error instances (without an
    // HTTP status). Keep those user-correctable validation failures as 400 while
    // treating errors from unknown application code as 500. This preserves the
    // established API contract without exposing internal implementation details.
    const fromDatabaseDomain = /[\\/]backend[\\/]db\.js(?::|$)/.test(String(e?.stack || ''));
    const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600
      ? e.status
      : (fromDatabaseDomain ? 400 : 500);
    const isPublicClientError = status >= 400 && status < 500;
    if (!isPublicClientError) {
      // Keep diagnostics on the server and correlate them with the response without
      // exposing stack traces, file paths, or database details to the client.
      console.error('[api-error]', JSON.stringify({
        requestId: res.get('X-Request-Id') || req.get('X-Request-Id') || '',
        method: req.method,
        path: req.path,
        status,
        message: e?.message || String(e)
      }));
    }
    const payload = { success: false, message: isPublicClientError ? (e.message || '请求失败') : '服务器暂时无法处理请求' };
    if (status === 409) payload.data = { revision: db.revision() };
    res.status(status).json(payload);
  });
  return router;
}
module.exports = install;
module.exports.bootstrap = bootstrap;
