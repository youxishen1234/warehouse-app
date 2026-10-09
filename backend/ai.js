const crypto = require('node:crypto');
const { interpret, validateIntent, validateImages, providerStatus } = require('./ai-provider');
const tools = require('./ai-tools');
const speech = require('./ai-speech');
const { consumeRateLimit } = require('./rate-limit');
const { numberValue, roundDecimal, lineAmount } = require('./stock-math');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const stockFields = {
  product_id: { type: 'integer', minimum: 1, description: '已核实的商品编号' },
  quantity: { type: 'number', exclusiveMinimum: 0 },
  unit_price: { type: 'number', minimum: 0 },
  unit: { type: 'string', maxLength: 20 },
  remark: { type: 'string', maxLength: 500 }
};
const TOOLS = [
  ['warehouse_stock_in', '商品入库，增加库存并按供应商生成应付。', 'stock_in', { ...stockFields, supplier_id: { type: 'integer', minimum: 1 } }, ['product_id', 'quantity']],
  ['warehouse_stock_out', '商品出库，检查库存并按客户生成应收。', 'stock_out', { ...stockFields, customer_id: { type: 'integer', minimum: 1 } }, ['product_id', 'quantity']],
  ['warehouse_print', '为指定流水生成可打印单据；返回打印内容，不代表打印机已经打印。', 'print', { transaction_id: { type: 'integer', minimum: 1 } }, ['transaction_id']]
].map(([name, description, action, fields, required]) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties: { action: { type: 'string', enum: [action] }, ...fields }, required: ['action', ...required], additionalProperties: false } }
}));

function objectBody(req, fields) {
  const body = req.body;
  if (!req.is('application/json') || !body || typeof body !== 'object' || Array.isArray(body)) throw fail('请求体必须是 JSON 对象');
  if (fields && Object.keys(body).some(key => !fields.includes(key))) throw fail('请求包含不支持的字段');
  return body;
}

function findTransaction(db, intent) {
  const list = db.listTx(intent.type ? { type: intent.type } : {}).filter(item => ['in', 'out'].includes(item.type));
  const transaction = intent.transaction_id ? list.find(item => item.id === intent.transaction_id) : intent.latest ? list[0] : null;
  if (!transaction) throw fail('未找到可打印的出入库流水，请核对编号和类型', 404);
  return transaction;
}

function prepare(db, intent) {
  if (tools.get(intent.action)) return tools.prepare(db, intent);
  const missing = [];
  const questions = [];
  const candidates = {};
  const need = (field, question) => { missing.push(field); questions.push(question); };
  const incomplete = () => ({ status: 'needs_input', reply: questions.join('；'), intent, missing_fields: missing, candidates });
  if (intent.action === 'unsupported') return { status: 'unsupported', intent, reply: '暂未识别出可执行操作。基础模式可以说“查询库存”“商品1入库20张”或“打印最近一笔出库单”；自由描述和单据照片需要配置 AI 模型。' };
  if (intent.action === 'print') {
    if (!intent.transaction_id && !intent.latest) { need('transaction_id', '要打印哪张单？请提供流水编号，或说“打印最近一笔入库单/出库单”'); return incomplete(); }
    const transaction = findTransaction(db, intent);
    return { status: 'ready', reply: `已找到${transaction.type === 'in' ? '入库' : '出库'}流水 ${transaction.id}，可以生成打印单据`, intent, command: { action: 'print', transaction_id: transaction.id }, preview: { transaction } };
  }
  const resolve = (kind, rows, label, required = false) => {
    const id = intent[`${kind}_id`];
    const name = intent[`${kind}_name`];
    if (!id && !name) {
      if (required) need(`${kind}_id`, `请提供${label}编号或完整名称`);
      return null;
    }
    const matches = rows.filter(item => !item.deleted_at && (!id || item.id === id) && (!name || item.name === name) && (kind !== 'product' || !intent.specification || item.specification === intent.specification));
    if (matches.length === 1) return matches[0];
    need(`${kind}_id`, matches.length ? `${label}有多个同名记录，请选择编号` : `未找到匹配的${label}，请核对编号、名称${kind === 'product' ? '和规格' : ''}`);
    candidates[kind] = { total: matches.length, items: matches.slice(0, 20).map(item => ({ id: item.id, name: item.name, ...(kind === 'product' ? { specification: item.specification || '', unit: item.unit, stock: item.stock } : {}) })) };
    return null;
  };
  const product = resolve('product', db.listProducts(), '商品', true);
  const incoming = intent.action === 'stock_in';
  const partyKind = incoming ? 'supplier' : 'customer';
  const party = resolve(partyKind, incoming ? db.listSuppliers() : db.listCustomers(), incoming ? '供应商' : '客户');
  if (intent.quantity === undefined) need('quantity', '请提供数量');
  if (missing.length) return incomplete();
  if (intent.unit && intent.unit !== product.unit) throw fail(`单位必须与商品库存单位「${product.unit}」一致`);
  if (!incoming && roundDecimal(product.stock, 6) < intent.quantity) throw fail(`库存不足：${product.name} 当前库存 ${product.stock}${product.unit}`);
  const stockAfter = roundDecimal(product.stock + (incoming ? intent.quantity : -intent.quantity), 6);
  const unitPrice = intent.unit_price ?? product.price;
  let amount;
  try { numberValue(stockAfter, '库存'); amount = lineAmount(intent.quantity, unitPrice); } catch (error) { throw fail(error.message); }
  const command = {
    action: intent.action, product_id: product.id, quantity: intent.quantity,
    unit: product.unit, unit_price: unitPrice,
    ...(party ? { [`${partyKind}_id`]: party.id } : {}), ...(intent.remark !== undefined ? { remark: intent.remark } : {})
  };
  return {
    status: 'ready', reply: `${product.name} ${incoming ? '入库' : '出库'} ${intent.quantity}${product.unit}，金额 ${amount.toFixed(2)} 元`, intent, command,
    preview: { product_id: product.id, product_name: product.name, specification: product.specification || '', quantity: intent.quantity, unit: product.unit, unit_price: unitPrice, amount, stock_before: product.stock, stock_after: stockAfter, ...(party ? { [`${partyKind}_id`]: party.id, [`${partyKind}_name`]: party.name } : {}) }
  };
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
function printDocument(transaction) {
  const title = `${transaction.type === 'in' ? '入库' : '出库'}单`;
  const text = escapeHtml;
  const timestamp = new Date(transaction.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} ${transaction.id}</title><style>@page{size:A4;margin:15mm}body{font:14px/1.7 system-ui,sans-serif;color:#111;margin:24px}h1{text-align:center;font-size:24px}table{width:100%;border-collapse:collapse;margin:20px 0}th,td{border:1px solid #444;padding:8px;text-align:left;overflow-wrap:anywhere}.meta{display:flex;justify-content:space-between;gap:16px}.remark{white-space:pre-wrap;overflow-wrap:anywhere}@media print{body{margin:0}}</style></head><body><h1>${title}</h1><div class="meta"><span>流水编号：${text(transaction.id)}</span><span>时间：${text(timestamp)}（北京时间）</span></div><p>${transaction.type === 'in' ? '供应商' : '客户'}：${text(transaction.supplier_name || transaction.customer_name || '未指定')}</p><table><thead><tr><th>商品</th><th>规格</th><th>数量</th><th>单位</th><th>单价</th><th>金额</th></tr></thead><tbody><tr><td>${text(transaction.product_name)}</td><td>${text(transaction.specification)}</td><td>${text(transaction.quantity)}</td><td>${text(transaction.unit)}</td><td>${text(transaction.unit_price)}</td><td>${text(Number(transaction.amount || 0).toFixed(2))}</td></tr></tbody></table><p>合计：${text(Number(transaction.amount || 0).toFixed(2))} 元</p><p class="remark">备注：${text(transaction.remark)}</p><p>操作人：${text(transaction.operator)}　　经手人：____________　　签收人：____________</p></body></html>`;
  return { title: `${title} ${transaction.id}`, filename: `warehouse-${transaction.type}-${transaction.id}.html`, html, transaction_id: transaction.id };
}

function install(router, db, options = {}) {
  const buckets = new Map();
  const settings = require('./ai-settings').createSettings(options.env || process.env);
  const route = (method, url, handler) => router[method](url, (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(error => {
    // Provider errors are deliberately sanitized at their source, never expose
    // response bodies, URLs, credentials or arbitrary exception messages.
    if (error.aiProviderError) return res.status(error.status).json({ success: false, message: error.message });
    return next(error);
  }));
  const send = (res, data) => { res.set('X-Warehouse-Revision', String(db.revision())); return res.json({ success: true, data: { ...data, revision: db.revision() } }); };
  const adminKeyConfigured = () => Boolean(String(options.env?.WAREHOUSE_ADMIN_KEY || '').trim());
  route('get', '/ai/status', (req, res) => send(res, { ...providerStatus(settings.current()), canConfigure: req.user?.role === 'admin' || adminKeyConfigured(), settingsAvailable: true,
    voice: (options.speechStatusImpl || speech.speechStatus)(options.env || process.env), photos: { available: providerStatus(settings.current()).mode === 'model', maxCount: 3, maxBytes: 2 * 1024 * 1024 } }));
  // 匿名共享模式下没有管理员账号：写操作由服务器配置的管理密钥（WAREHOUSE_ADMIN_KEY）保护；
  // 保留 role==='admin' 作为测试注入与未来账号体系的兼容路径。
  const admin = req => {
    if (req.user?.role === 'admin') return;
    const configured = String(options.env?.WAREHOUSE_ADMIN_KEY || '').trim();
    if (!configured) throw fail('服务器未配置管理密钥（WAREHOUSE_ADMIN_KEY），请联系管理员', 403);
    const provided = String(req.get('X-Warehouse-Admin-Key') || req.body?.admin_key || '').trim();
    if (!provided || provided !== configured) throw fail('管理密钥不正确', 403);
  };
  route('get', '/ai/config', (req, res) => send(res, settings.publicConfig()));
  const checkConnection = async env => {
    if (providerStatus(env).mode !== 'model') throw fail('请先完整填写服务地址、API Key 和模型名称');
    const result = await interpret('查询库存', undefined, { ...options, env, timeoutMs: 25000 });
    if (result.provider !== 'model' || result.intent.action !== 'query' || result.intent.parameters?.resource !== 'products') throw fail('模型已响应，但未通过仓库工具调用测试；请选择支持工具调用的模型', 502);
    return { connected: true, model: env.WAREHOUSE_AI_MODEL, message: '模型连接和仓库工具调用测试通过；照片识别还需模型支持图片输入' };
  };
  const limitedCheck = async (req, env) => {
    if (!consumeRateLimit(buckets, `test:${req.user?.id || req.ip}`, { limit: 5 })) throw fail('连接测试过于频繁，请一分钟后重试', 429);
    try { return await checkConnection(env); } catch (error) { error.aiProviderError = true; throw error; }
  };
  route('post', '/ai/connection-test', async (req, res) => send(res, await limitedCheck(req, settings.current())));
  route('post', '/ai/config/test', async (req, res) => { admin(req); return send(res, await limitedCheck(req, settings.candidate(req.body))); });
  route('put', '/ai/config', async (req, res) => {
    admin(req);
    const candidate = settings.candidate(req.body);
    const checked = await limitedCheck(req, candidate);
    return send(res, { ...settings.save(candidate), ...checked });
  });
  route('get', '/ai/tools', (req, res) => send(res, {
    tools: [...TOOLS, ...tools.definitions()], capabilities: tools.capabilities(), endpoint: '/api/ai/execute', command_endpoint: '/api/ai/command', photo_endpoint: '/api/ai/photo', voice_endpoint: '/api/ai/voice',
    write_headers: ['Idempotency-Key', 'If-Match'], print_result: 'html',
    scope: '业务查询、商品/客户/供应商、订单、单据入库、纸板收发/盘点、账目、打印及功能导航'
  }));
  route('post', '/ai/prepare', (req, res) => send(res, prepare(db, validateIntent(objectBody(req, ['intent']).intent))));
  const command = kind => async (req, res) => {
    const body = objectBody(req, ['message', 'context', 'images', ...(kind === 'voice' ? ['audio'] : [])]);
    const images = validateImages(body.images);
    if (kind === 'photo' && !images.length) throw fail('请上传至少一张单据照片');
    let message = body.message ?? (kind === 'photo' ? '请识别入库单，整理入库明细' : kind === 'voice' ? '' : undefined);
    if (typeof message !== 'string' || (kind !== 'voice' && !message.trim()) || message.length > 2000) throw fail('请输入 1 至 2000 字的仓库指令');
    const context = body.context === undefined ? undefined : validateIntent(body.context);
    const audio = kind === 'voice' ? speech.validateAudio(body.audio) : undefined;
    const configuredLimit = Number((options.env || process.env).WAREHOUSE_AI_RATE_LIMIT);
    const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? Math.min(1000, configuredLimit) : 20;
    if (!consumeRateLimit(buckets, String(req.warehouseClientIp || req.ip || 'unknown'), { limit })) {
      res.set('Retry-After', '60'); throw fail('AI 请求过于频繁，请稍后重试', 429);
    }
    let parsed;
    let transcript;
    let durationSeconds;
    try {
      if (audio) {
        if (!consumeRateLimit(buckets, `voice:${req.warehouseClientIp || req.ip || 'unknown'}`, { limit: 6 })) throw fail('语音发送过于频繁，请一分钟后重试', 429);
        const controller = new AbortController();
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        req.once('aborted', disconnected); res.once('close', disconnected);
        try {
          const result = await (options.transcribeImpl || speech.transcribe)(audio, { env: options.env || process.env, signal: controller.signal });
          if (controller.signal.aborted) return;
          if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 2000) throw fail('没有识别出有效语音，请重新录制', 502);
          transcript = result.text.trim(); durationSeconds = result.seconds;
          message = `${transcript}${message.trim() ? `\n补充说明：${message.trim()}` : ''}`;
          if (message.length > 2000) throw fail('语音和补充说明合计不能超过 2000 字，请分段发送');
        } finally { req.removeListener('aborted', disconnected); res.removeListener('close', disconnected); }
      }
      parsed = await interpret(message, context, { ...options, env: settings.current(), images });
    }
    catch (error) { if (error.status >= 500) error.aiProviderError = true; throw error; }
    return send(res, { ...prepare(db, parsed.intent), provider: parsed.provider, ...(transcript ? { transcript, durationSeconds, input_type: 'voice' } : kind === 'photo' ? { input_type: 'photo' } : {}) });
  };
  route('post', '/ai/command', command('text'));
  route('post', '/ai/photo', command('photo'));
  route('post', '/ai/voice', command('voice'));
  route('post', '/ai/execute', (req, res) => {
    const command = validateIntent(objectBody(req));
    const extension = tools.get(command.action);
    if (extension) {
      if (extension.mode !== 'write') return send(res, tools.run(db, command, req.user));
      const key = String(req.get('Idempotency-Key') || '');
      if (!/^[\w-]{16,100}$/.test(key)) throw fail('缺少有效的提交编号');
      const expected = req.get('If-Match');
      if (!/^(?:0|[1-9]\d*)$/.test(expected || '')) throw fail('缺少有效的数据版本 If-Match');
      const fingerprint = crypto.createHash('sha256').update('POST /ai/execute' + JSON.stringify(command)).digest('hex');
      const result = db.transact(req.user, key, fingerprint, expected, `AI ${command.action}`, () => tools.run(db, command, req.user));
      return send(res, { ...result.data, replayed: result.replayed });
    }
    const tool = TOOLS.find(item => item.function.parameters.properties.action.enum[0] === command.action);
    if (!tool) throw fail('不支持的仓库操作');
    const schema = tool.function.parameters;
    if (Object.keys(command).some(key => !Object.hasOwn(schema.properties, key))) throw fail('执行接口只接受已解析的编号和业务参数');
    if (schema.required.some(key => command[key] === undefined)) throw fail('执行参数不完整，请先补充商品、数量或流水编号');
    if (command.action === 'print') {
      return send(res, { status: 'print_ready', action: 'print', reply: '打印内容已生成，请由客户端打开预览并调用打印机', document: printDocument(findTransaction(db, command)) });
    }
    const key = String(req.get('Idempotency-Key') || '');
    if (!/^[\w-]{16,100}$/.test(key)) throw fail('缺少有效的提交编号');
    const expected = req.get('If-Match');
    if (!/^(?:0|[1-9]\d*)$/.test(expected || '')) throw fail('缺少有效的数据版本 If-Match');
    const fingerprint = crypto.createHash('sha256').update('POST /ai/execute' + JSON.stringify(command)).digest('hex');
    const result = db.transact(req.user, key, fingerprint, expected, `AI ${command.action}`, () => {
      const incoming = command.action === 'stock_in';
      const value = db[incoming ? 'stockIn' : 'stockOut'](command.product_id, command.quantity, req.user.username, command.remark || '', incoming ? command.supplier_id : command.customer_id, command);
      return { status: 'completed', action: command.action, reply: `${incoming ? '入库' : '出库'}成功：${value.transaction.product_name} ${value.transaction.quantity}${value.transaction.unit}`, ...value };
    });
    return send(res, { ...result.data, replayed: result.replayed });
  });
}

module.exports = { install };
