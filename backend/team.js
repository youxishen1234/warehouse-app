const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ORDER_STATUSES, validateSortQuery, sortList } = require('./list-sort');
const { parseDateQuery } = require('./date-query');
const updates = require('./updates');
const { consumeRateLimit } = require('./rate-limit');
const hotUpdateStatsRateLimit = () => Math.max(2, Math.min(1000, Number(process.env.WAREHOUSE_HOTUPDATE_STATS_RATE_LIMIT) || 60));
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

// Emit large JSON responses incrementally while preserving their wire shape.
// Arrays are written item by item so Express does not first build one giant
// serialized string for backup/export responses.
async function streamJson(res, value) {
  res.type('application/json');
  const write = async chunk => {
    if (res.write(chunk)) return;
    await new Promise(resolve => res.once('drain', resolve));
  };
  const emit = async input => {
    if (input === null || typeof input !== 'object') return write(JSON.stringify(input));
    if (Array.isArray(input)) {
      await write('[');
      for (let index = 0; index < input.length; index += 1) {
        if (index) await write(',');
        await emit(input[index]);
        if (index % 128 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      return write(']');
    }
    await write('{');
    const entries = Object.entries(input);
    for (let index = 0; index < entries.length; index += 1) {
      if (index) await write(',');
      await write(JSON.stringify(entries[index][0]));
      await write(':');
      await emit(entries[index][1]);
    }
    return write('}');
  };
  await emit(value);
  res.end();
}
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const IDENTITY_KEY_PATTERN = /^[\w-]{16,100}$/;
const requiresIdempotencyKey = pathName => /^\/(?:products|customers|suppliers|orders|transactions|ledger|stock(?:\/in|\/out|\/out\/batch)?|backup|stocktake|delivery-notes)(?:\/|$)/.test(pathName);
function install(db) {
  const router = require('express').Router();
  const guestSessions = new Map();
  const statsBuckets = new Map();
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
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()'
    });
    next();
  });
  route('get', '/health', (req, res) => ok(res, { ...db.health(), authentication: false }));
  const bearer = req => String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const actorFor = req => {
    const token = bearer(req);
    const session = token ? guestSessions.get(digest(token)) : null;
    if (session && session.expires > Date.now()) return session.actor;
    const device = `${String(req.get('X-Warehouse-Device') || 'anonymous').slice(0, 80)}:${String(req.warehouseClientIp || req.ip || 'unknown')}`;
    return { id: `anonymous:${digest(device).slice(0, 40)}`, username: '\u533f\u540d\u7528\u6237' };
  };
  // Guest bootstrap is optional for clients that retain a session token.
  // The token identifies an anonymous actor only; it grants no role or account privileges.
  route('post', '/auth/guest', (req, res) => {
    const now = Date.now();
    for (const [key, session] of guestSessions) if (session.expires <= now) guestSessions.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    const actor = { id: `guest:${crypto.randomUUID()}`, username: '\u533f\u540d\u7528\u6237' };
    const expires = now + 12 * 3600000;
    guestSessions.set(digest(token), { actor, expires });
    ok(res, { token, user: actor, expires });
  });
  router.use((req, res, next) => {
    req.user = actorFor(req);
    req.sessionKey = bearer(req) ? digest(bearer(req)) : '';
    next();
  });
  // Keep the write-key contract in one place. Route handlers retain their
  // defensive checks for direct reuse, but malformed keys are rejected before
  // business validation or persistence can run.
  router.use((req, res, next) => {
    if (!['POST', 'PUT', 'DELETE'].includes(req.method) || !requiresIdempotencyKey(req.path)) return next();
    if (!IDENTITY_KEY_PATTERN.test(String(req.get('Idempotency-Key') || ''))) return next(error('缺少有效的提交编号', 400));
    next();
  });
  route('get', '/auth/me', (req, res) => ok(res, req.user));
  route('post', '/auth/logout', (req, res) => { if (req.sessionKey) guestSessions.delete(req.sessionKey); ok(res, true); });
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
  // Keep the hot-update dashboard on the shared anonymous API router. Defining
  // it here avoids the router's unknown-route guard swallowing this endpoint.
  route('get', '/appupdate/stats', (req, res) => {
    const bucketKey = `${req.warehouseClientIp || req.ip || 'unknown'}:${String(req.get('X-Warehouse-Device') || 'unknown').slice(0, 80)}`;
    if (!consumeRateLimit(statsBuckets, bucketKey, { limit: hotUpdateStatsRateLimit() })) {
      res.set('Retry-After', '60');
      throw error('热更新统计请求过于频繁，请稍后重试', 429);
    }
    ok(res, updates.stats(updates.parseRecent(req.query.recent)));
  });
  route('get', '/audit', (req, res) => {
    const rawPage = req.query.page;
    if (rawPage !== undefined && (typeof rawPage !== 'string' || !/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage)))) {
      throw error('\u9875\u7801\u5fc5\u987b\u662f\u6b63\u6574\u6570', 400);
    }
    const page = rawPage === undefined ? 1 : Number(rawPage);
    const all = db.audit().slice().sort((a,b) => b.time-a.time);
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
  route('get', '/backup', (req, res) => { streamJson(res, { success: true, data: { exportedAt: new Date().toISOString(), data: db.backupData() } }); });
  route('post', '/backup', (req, res) => { const key=req.get('Idempotency-Key'); const payload=req.body?.data || req.body; const result=db.transact(req.user,key,digest(JSON.stringify(payload)),req.get('If-Match'),'POST /backup',()=>db.restoreData(payload)); res.set('X-Warehouse-Revision',String(result.revision)); ok(res,result.data); });
  route('post', '/stock/out/batch', (req, res) => { const key=req.get('Idempotency-Key'); const body=req.body||{}; const result=db.transact(req.user,key,digest('POST /stock/out/batch'+JSON.stringify(body)),req.get('If-Match'),'POST /stock/out/batch',()=>({ transactions: db.stockOutBatch(body.lines,body.operator||req.user.username,body.remark||'',body.customer_id) })); res.set('X-Warehouse-Revision',String(result.revision)); ok(res,result.data); });
  route('post', '/orders/:id/outbound', (req, res) => { const key=req.get('Idempotency-Key'); const body=req.body||{}; const lines=Array.isArray(body.lines) ? body.lines : (body.product_id !== undefined ? [{ product_id: body.product_id, quantity: body.quantity, unit_price: body.unit_price }] : []); const result=db.transact(req.user,key,digest('POST /orders/'+req.params.id+'/outbound'+JSON.stringify(body)),req.get('If-Match'),'POST /orders/:id/outbound',()=>db.orderToOutbound(Number(req.params.id), lines, body.operator||req.user.username, body.remark||'')); res.set('X-Warehouse-Revision',String(result.revision)); ok(res,result.data); });
  route('get', '/export/transactions.csv', async (req, res) => {
    validateListQuery(req.query, 'transactions');
    const streamed = !req.query.sort && !req.query.order && db.streamTx ? db.streamTx(req.query) : null;
    const rows = streamed ? streamed.rows : sortList(db.listTx(req.query), req.query, 'transactions');
    if (streamed ? streamed.count === 0 : rows.length === 0) throw error('\u6ca1\u6709\u7b26\u5408\u6761\u4ef6\u7684\u6d41\u6c34\u53ef\u5bfc\u51fa', 404);
    await streamCsv(res, ['??','??','??','??','??','??','??','??','??','??','???','??','??'], rows, t => [new Date(t.created_at).toISOString(),t.type,t.product_name||'',t.specification||'',t.material||'',t.type === 'adjustment' ? t.adjustment : t.quantity||0,t.unit||'',t.unit_price||0,t.amount||0,t.customer_name||'',t.supplier_name||'',t.remark||'',t.voided_at ? '????????????' : '??']);
  });
  route('get', '/export/ledger.csv', async (req, res) => {
    validateListQuery(req.query, 'ledger');
    const streamed = !req.query.sort && !req.query.order && db.streamLedger ? db.streamLedger(req.query) : null;
    const rows = streamed ? streamed.rows : sortList(db.listLedger(req.query), req.query, 'ledger');
    if (streamed ? streamed.count === 0 : rows.length === 0) throw error('\u6ca1\u6709\u7b26\u5408\u6761\u4ef6\u7684\u8d26\u672c\u6d41\u6c34\u53ef\u5bfc\u51fa', 404);
    await streamCsv(res, ['??','??','??','????','??'], rows, x => [new Date(x.created_at).toISOString(),x.type,x.amount,x.party_name||'',x.remark||'']);
  });
  route('post', '/stocktake', (req, res) => { const key=req.get('Idempotency-Key'); const result=db.transact(req.user,key,digest(JSON.stringify(req.body)),req.get('If-Match'), 'POST /stocktake',()=>db.addStocktake(req.body)); res.set('X-Warehouse-Revision',String(result.revision)); ok(res,result.data); });
  route('get', '/stocktakes', (req, res) => { validateListQuery(req.query, 'stocktakes'); return ok(res, paginateList(sortList(db.listStocktakes(req.query), req.query, 'stocktakes'), req.query)); });
  route('get', '/delivery-notes', (req, res) => { validateListQuery(req.query, 'delivery_notes'); return ok(res, paginateList(sortList(db.listDeliveryNotes(), req.query, 'delivery_notes'), req.query)); });
  route('get', '/delivery-notes/:id', (req, res) => { const note=db.getDeliveryNote(Number(req.params.id)); if(!note) throw error('送货单不存在',404); ok(res,note); });
  route('post', '/delivery-notes', (req, res) => { const remark = req.body?.remark;
    if (remark !== undefined && (typeof remark !== 'string' || remark.length > 500)) throw error('remark 长度不能超过 500 个字符且必须为文本');
    const key = req.get('Idempotency-Key');
    const result = db.transact(req.user, key, digest('POST /delivery-notes' + JSON.stringify(req.body)), req.get('If-Match'), 'POST /delivery-notes', () => db.addDeliveryNote({ ...req.body, operator: req.body.operator || req.user.username }));
    res.set('X-Warehouse-Revision', String(result.revision));
    ok(res, result.data);
  });
  route('delete', '/delivery-notes/:id', (req, res) => { const key = req.get('Idempotency-Key');
    const operation = `DELETE /delivery-notes/${req.params.id}`;
    const result = db.transact(req.user, key, digest(operation), req.get('If-Match'), operation, () => db.voidDeliveryNote(Number(req.params.id)));
    res.set('X-Warehouse-Revision', String(result.revision)); ok(res, result.data);
  });
  route('get', '/boards', (req, res) => ok(res, db.listBoards()));
  route('get', '/boards/:id', (req, res) => {
    const batch = db.listBoards().find(b => b.id === req.params.id);
    if (!batch) throw error('找不到这批纸板，请检查标签', 404);
    ok(res, batch);
  });
  for (const endpoint of ['/boards', '/boards/:id/movements']) route('post', endpoint, (req, res) => {
    if (!IDENTITY_KEY_PATTERN.test(String(req.get('Idempotency-Key') || ''))) throw error('缺少有效的提交编号');
    if (!req.is('application/json') || !req.body || Array.isArray(req.body)) throw error('请提交有效的纸板数据');
    const operation = `POST ${req.path}`;
    const result = db.transact(req.user, req.get('Idempotency-Key'), digest(operation + JSON.stringify(req.body)), req.get('If-Match'), operation, () => req.params.id ? db.moveBoard(req.params.id, req.body) : db.receiveBoard(req.body));
    res.set('X-Warehouse-Revision', String(result.revision));
    ok(res, result.data);
  });
  route('post', '/sync/upload', (req, res) => ok(res, { ok: true, received: true }));
  route('post', '/products/:id/image', (req, res) => {
    const key = req.get('Idempotency-Key');
    const raw = String(req.body?.data || '');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(raw);
    if (!match) throw error('仅支持 PNG、JPEG 或 WebP 图片');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw error('图片解码后大小不能超过 2 MiB');
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
      } const key = req.get('Idempotency-Key');
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
