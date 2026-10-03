// Register a business operation here once: model tools, API validation and the
// assistant's editable forms all use this catalogue. Never accept a model URL,
// method name, SQL statement or executable code as a tool implementation.
const { numberValue, roundDecimal } = require('./stock-math');
const { ORDER_STATUSES } = require('./list-sort');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const str = (title, maxLength = 100) => ({ type: 'string', title, maxLength });
const num = (title, minimum = 0) => ({ type: 'number', title, minimum });
const id = title => ({ type: 'integer', title, minimum: 1 });
const choice = (title, values) => ({ type: 'string', title, enum: values });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const lines = (title, schema) => ({ type: 'array', title, items: schema, minItems: 1, maxItems: 20 });
const catalog = new Map();
function register(action, title, schema, mode, run, options = {}) {
  if (catalog.has(action)) throw new Error(`Duplicate AI operation: ${action}`);
  catalog.set(action, { action, title, schema, mode, run, ...options });
}
function validate(value, schema, partial = false, path = '') {
  const label = schema.title || path || '参数';
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label}必须为对象`);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (!Object.hasOwn(schema.properties, key)) throw fail(`${label}包含不支持的字段 ${key}`);
      result[key] = validate(value[key], schema.properties[key], partial, path ? `${path}.${key}` : key);
    }
    if (!partial) for (const key of schema.required || []) if (result[key] === undefined || result[key] === '') throw fail(`请填写${schema.properties[key].title || key}`);
    return result;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems || (!partial && value.length < schema.minItems)) throw fail(`${label}需要 1 至 ${schema.maxItems} 行`);
    return value.map((item, index) => validate(item, schema.items, partial, `${label}第${index + 1}行`));
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength || 500)) throw fail(`${label}格式或长度无效`);
    if (schema.enum && !schema.enum.includes(value)) throw fail(`${label}请选择${schema.enum.join('、')}`);
    return value.trim();
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw fail(`${label}必须为是或否`);
    return value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (schema.minimum || 0) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) || (schema.maximum !== undefined && value > schema.maximum) || (schema.type === 'integer' && !Number.isSafeInteger(value))) throw fail(`${label}数值无效`);
  try { numberValue(value, label); } catch (error) { throw fail(error.message); }
  return value;
}
function missing(value, schema, prefix = '') {
  if (schema.type === 'object') return Object.entries(schema.properties).flatMap(([key, field]) => {
    const label = prefix + (field.title || key);
    const item = value?.[key];
    if (item === undefined || item === '') return (schema.required || []).includes(key) ? [label] : [];
    return missing(item, field, prefix);
  });
  if (schema.type === 'array') return !value.length ? [schema.title] : value.flatMap((item, index) => missing(item, schema.items, `${schema.title}第${index + 1}行：`));
  return [];
}
const productRef = { product_id: id('商品编号'), product_name: str('商品名称', 50), specification: str('规格') };
const supplierRef = { supplier_id: id('供应商编号'), supplier_name: str('供应商名称', 50) };
const customerRef = { customer_id: id('客户编号'), customer_name: str('客户名称', 50) };
const remark = str('备注', 500);
const quantity = { ...num('数量'), exclusiveMinimum: 0 };
const stockLine = obj({ ...productRef, quantity, unit: str('单位', 20), unit_price: num('单价'), remark }, ['product_id', 'quantity']);
const receiptLine = obj({ ...stockLine.properties, delivered_qty: num('实际入库数量') }, ['product_id', 'quantity', 'delivered_qty', 'unit_price']);
function resolveReferences(db, params, issues = [], path = '', candidatePath = '') {
  for (const [kind, getter, label] of [['product', 'listProducts', '商品'], ['supplier', 'listSuppliers', '供应商'], ['customer', 'listCustomers', '客户']]) {
    const key = `${kind}_id`, name = `${kind}_name`;
    if (params[key] === undefined && !params[name]) continue;
    const matches = db[getter]().filter(row => !row.deleted_at && (params[key] === undefined || row.id === params[key]) && (!params[name] || row.name === params[name]) && (kind !== 'product' || !params.specification || params.specification === row.specification));
    if (matches.length !== 1) {
      issues.push(`${path}${label}${matches.length ? '存在同名记录，请选择下方候选' : '未找到，请核对名称、编号和规格'}`);
      issues.candidates ||= [];
      const search = String(name || '').toLowerCase();
      const suggestions = matches.length ? matches : db[getter]().filter(row => !row.deleted_at && (!search || row.name.toLowerCase().includes(search)));
      issues.candidates.push({ path: `${candidatePath}${key}`, kind, items: suggestions.slice(0, 20).map(row => ({ id: row.id, name: row.name, ...(kind === 'product' ? { specification: row.specification || '', unit: row.unit, stock: row.stock } : {}) })) });
    } else {
      params[key] = matches[0].id;
      delete params[name];
      if (kind === 'product' && params.quantity !== undefined) {
        if (params.unit && params.unit !== matches[0].unit) throw fail(`单位必须与商品库存单位「${matches[0].unit}」一致`);
        params.unit ||= matches[0].unit;
        if (params.unit_price === undefined) params.unit_price = matches[0].price;
      }
    }
  }
  if (Array.isArray(params.lines)) params.lines.forEach((line, index) => resolveReferences(db, line, issues, `${path}第${index + 1}行：`, `${candidatePath}lines.${index}.`));
  return issues;
}

const resources = {
  products: ['商品库存', 'listProducts'], customers: ['客户', 'listCustomers'], suppliers: ['供应商', 'listSuppliers'],
  orders: ['订单', 'listOrders'], transactions: ['出入库流水', 'listTx'], ledger: ['账本', 'listLedger'],
  boards: ['纸板批次', 'listBoards'], delivery_notes: ['送货入库单', 'listDeliveryNotes'], stocktakes: ['盘点', 'listStocktakes'], audit: ['操作记录', 'audit']
};
register('query', '查询业务数据', obj({ resource: choice('查询内容', [...Object.keys(resources), 'stats']), keyword: str('关键词'), record_id: str('记录编号'), page: id('页码'), page_size: { ...id('每页条数'), maximum: 50 } }, ['resource']), 'read', (db, p) => {
  if (p.resource === 'stats') return { title: '仓库统计', items: [db.stats()], total: 1 };
  let rows = db[resources[p.resource][1]]();
  if (p.record_id) rows = rows.filter(row => String(row.id) === p.record_id);
  if (p.keyword) rows = rows.filter(row => Object.entries(row).some(([key, value]) => !['movements'].includes(key) && typeof value === 'string' && value.toLowerCase().includes(p.keyword.toLowerCase())));
  const size = Math.min(p.page_size || 20, 50), start = ((p.page || 1) - 1) * size;
  if (!Number.isSafeInteger(start)) throw fail('页码超出范围');
  return { title: resources[p.resource][0], items: rows.slice(start, start + size).map(({ movements, ...row }) => row), total: rows.length, page: p.page || 1, page_size: size };
});

const partyFields = { name: str('名称', 50), contact: str('联系人', 50), phone: str('电话', 20), address: str('地址', 200), remark };
const productFields = { name: str('商品名称', 50), category: str('分类', 50), specification: str('规格'), material: str('材质'), unit: str('库存单位', 20), price: num('单价'), safety_stock: num('预警库存'), length: num('长度'), width: num('宽度'), layers: num('层数'), corrugation: str('楞型'), weight: num('克重') };
for (const [kind, label, prefix, fields] of [['product', '商品', 'Product', productFields], ['customer', '客户', 'Customer', partyFields], ['supplier', '供应商', 'Supplier', partyFields]]) {
  register(`${kind}_create`, `新增${label}`, obj(fields, kind === 'product' ? ['name', 'unit', 'price'] : ['name']), 'write', (db, p) => db[`add${prefix}`](p));
  register(`${kind}_update`, `修改${label}`, obj({ id: id(`${label}编号`), changes: { ...obj(fields), title: '修改内容' } }, ['id', 'changes']), 'write', (db, p) => {
    if (!Object.keys(p.changes).length) throw fail('请填写要修改的内容');
    return db[`update${prefix}`](p.id, p.changes);
  });
  register(`${kind}_delete`, `停用${label}`, obj({ id: id(`${label}编号`) }, ['id']), 'write', (db, p) => { db[`delete${prefix}`](p.id); return { id: p.id }; }, { destructive: true });
}
register('receipt_in', '送货单入库（支持照片、多行）', obj({ ...supplierRef, date: str('单据日期 YYYY-MM-DD', 10), work_order_no: str('送货单号/采购单号', 50), freight: num('运费'), driver_phone: str('司机电话', 20), vehicle_no: str('车牌', 20), remark, lines: lines('商品明细', receiptLine) }, ['supplier_id', 'date', 'lines']), 'write', (db, p, actor) => db.addDeliveryNote({ ...p, operator: actor.username }), { references: true });
register('stock_out_batch', '多商品出库', obj({ ...customerRef, remark, lines: lines('商品明细', stockLine) }, ['customer_id', 'lines']), 'write', (db, p, actor) => ({ transactions: db.stockOutBatch(p.lines, actor.username, p.remark || '', p.customer_id) }), { references: true });
const orderFields = { order_no: str('订单号', 50), ...customerRef, specification: str('规格'), material: str('材质'), quantity, unit: str('单位', 20), unit_price: num('单价'), delivery_date: str('交货日期', 10), status: choice('订单状态', ORDER_STATUSES), remark };
register('order_create', '创建订单', obj(orderFields, ['order_no', 'customer_id', 'quantity', 'unit_price']), 'write', (db, p) => db.addOrder(p), { references: true });
register('order_update', '修改订单/状态', obj({ id: id('订单编号'), changes: { ...obj(orderFields), title: '修改内容' } }, ['id', 'changes']), 'write', (db, p) => {
  if (!Object.keys(p.changes).length) throw fail('请填写修改内容');
  const issues = resolveReferences(db, p.changes); if (issues.length) throw fail(issues.join('；'));
  return db.updateOrder(p.id, p.changes);
});
register('order_outbound', '订单出库', obj({ id: id('订单编号'), remark, lines: lines('商品明细', stockLine) }, ['id', 'lines']), 'write', (db, p, actor) => db.orderToOutbound(p.id, p.lines, actor.username, p.remark || ''), { references: true });
register('stocktake', '商品盘点', obj({ ...productRef, counted_stock: num('实盘库存'), counted_at: str('盘点日期', 10), remark }, ['product_id', 'counted_stock', 'remark']), 'write', (db, p, actor) => db.addStocktake({ ...p, operator: actor.username }), { references: true });
register('ledger_add', '记录收入/支出', obj({ type: choice('类型', ['income', 'expense']), amount: quantity, remark }, ['type', 'amount', 'remark']), 'write', (db, p) => db.addLedger(p));
register('settlement', '客户收款/供应商付款', obj({ party_type: choice('往来方类型', ['customer', 'supplier']), id: id('往来方编号'), party_name: str('往来方完整名称', 50), amount: { ...num('结算金额', 0.01) }, remark }, ['party_type', 'amount']), 'write', (db, p) => {
  const customer = p.party_type === 'customer';
  const party = db[customer ? 'getCustomer' : 'getSupplier'](p.id);
  if (!party || party.deleted_at) throw fail('往来方不存在或已停用');
  const field = customer ? 'debt' : 'payable';
  if (roundDecimal(p.amount, 2) !== p.amount || p.amount > party[field]) throw fail('结算金额最多两位小数，且不能超过当前未结余额');
  return db[customer ? 'updateCustomer' : 'updateSupplier'](p.id, { [field]: roundDecimal(party[field] - p.amount, 2), settlement_remark: p.remark || 'AI 助手结算' });
});
for (const [action, title, method] of [['transaction_void', '作废出入库流水', 'deleteTransaction'], ['receipt_void', '作废送货入库单', 'voidDeliveryNote'], ['ledger_void', '作废手工账目', 'deleteLedger']]) register(action, title, obj({ id: id('记录编号') }, ['id']), 'write', (db, p) => db[method](p.id), { destructive: true });

const boardFields = {
  supplier: str('板厂', 120), date: str('送货日期 YYYY-MM-DD', 10), deliveryNo: str('送货单号', 120),
  boardLength: num('纸板长 cm'), boardWidth: num('纸板宽 cm'), cartonLength: num('纸箱长 cm'), cartonWidth: num('纸箱宽 cm'), cartonHeight: num('纸箱高 cm'),
  fluteType: str('楞型', 12), layers: num('层数'), faceGsm: num('面纸克重'), linerGsm: num('里纸克重'), flutingGsm: num('瓦纸克重'),
  orderedQty: num('订购张数'), receivedQty: num('实收张数'), billedArea: num('计费平米'), unitPrice: num('每平米单价'), location: str('库位'), warningQty: num('预警张数'), remark
};
const requiredBoard = ['supplier', 'date', 'boardLength', 'boardWidth', 'cartonLength', 'cartonWidth', 'cartonHeight', 'fluteType', 'layers', 'orderedQty', 'receivedQty', 'billedArea', 'unitPrice'];
const batchId = str('纸板批次编号', 80);
register('board_receive', '纸板批次入库（支持照片）', obj({ batches: lines('纸板批次', obj(boardFields, requiredBoard)) }, ['batches']), 'write', (db, p) => ({ batches: p.batches.map(row => db.receiveBoard(row)) }));
register('board_move', '纸板领料/盘点', obj({ id: batchId, type: choice('操作', ['out', 'count']), quantity: num('领料张数/实盘张数'), recipient: str('领料人'), remark }, ['id', 'type', 'quantity', 'remark']), 'write', (db, p) => db.moveBoard(p.id, p));
register('board_update', '修改纸板入库单', obj({ id: batchId, ...boardFields }, ['id', ...requiredBoard]), 'write', (db, p) => db.updateBoard(p.id, p));
register('board_delete', '删除未领用纸板批次', obj({ id: batchId }, ['id']), 'write', (db, p) => db.deleteBoard(p.id), { destructive: true });
const pages = { home: '首页', inventory: '库存查询', products: '商品管理', customers: '客户管理', suppliers: '供应商管理', orders: '客户订单/尺寸本', records: '出入库记录', ledger: '账本', 'board-stock': '纸板库存', 'board-receive': '纸板入库', 'board-calculator': '纸箱计算器/拍照测量', backup: '备份恢复', mine: '我的/服务器设置', 'custom-copy': '自定义文案', 'print-center': '打印中心' };
Object.assign(pages, { 'board-scan': '扫描纸板二维码', 'qr-test': '二维码测试', 'customer-edit': '客户资料编辑', 'product-edit': '商品资料编辑', team: '团队和访问权限' });
register('open_page', '打开其他功能页面', obj({ page: choice('功能页面', Object.keys(pages)) }, ['page']), 'navigate', (db, p) => ({ url: `/pages/${p.page}/index`, title: pages[p.page] }));
const htmlText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
register('print_record', '打印送货入库单/订单/纸板批次', obj({ resource: choice('单据类型', ['delivery_notes', 'orders', 'boards']), id: str('单据编号', 80) }, ['resource', 'id']), 'print', (db, p) => {
  const item = db[resources[p.resource][1]]().find(row => String(row.id) === p.id && !row.voided_at);
  if (!item) throw fail('单据不存在或已作废', 404);
  const title = `${resources[p.resource][0]} ${item.work_order_no || item.order_no || item.id}`;
  const rows = p.resource === 'delivery_notes' ? item.lines.map(row => [row.product_name, row.specification, row.delivered_qty, row.unit, row.unit_price, row.amount])
    : p.resource === 'boards' ? [['纸板', `${item.boardLength} × ${item.boardWidth} cm / ${item.fluteType}`, item.receivedQty, '张', `计费 ${item.billedArea} ㎡ × ${item.unitPrice} 元/㎡`, item.amount]]
      : [['订单商品', item.specification, item.quantity, item.unit, item.unit_price, item.amount]];
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${htmlText(title)}</title><style>@page{size:A4;margin:15mm}body{font:14px/1.7 sans-serif;color:#111;padding:20px}h1{text-align:center;font-size:22px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #555;padding:8px;overflow-wrap:anywhere}p{white-space:pre-wrap}</style></head><body><h1>${htmlText(title)}</h1><p>往来方：${htmlText(item.supplier_name || item.customer_name || item.supplier)}　日期：${htmlText(item.date || item.delivery_date)}</p><table><tr>${['商品', '规格', '数量', '单位', '单价/计费依据', '金额'].map(label => `<th>${label}</th>`).join('')}</tr>${rows.map(row => `<tr>${row.map(value => `<td>${htmlText(value)}</td>`).join('')}</tr>`).join('')}</table><p>货款合计：${htmlText(item.total_amount ?? item.amount)} 元</p>${p.resource === 'delivery_notes' ? `<p>运费（单独记录）：${htmlText(item.freight)} 元</p>` : ''}<p>备注：${htmlText(item.remark)}</p><p>经手人：____________　签收人：____________</p></body></html>`;
  return { status: 'print_ready', action: 'print_record', reply: '单据已生成，可以预览和打印', document: { title, filename: `warehouse-${p.resource}-${item.id}.html`, html } };
});

function get(action) { return catalog.get(action); }
function intent(raw) {
  if (Object.keys(raw).some(key => !['action', 'parameters'].includes(key))) throw fail('扩展工具只接受 action 和 parameters');
  return { action: raw.action, parameters: validate(raw.parameters || {}, get(raw.action).schema, true) };
}
function prepare(db, input) {
  const tool = get(input.action);
  const params = validate(input.parameters || {}, tool.schema, true);
  const issues = tool.references ? resolveReferences(db, params) : [];
  const targetMatch = /^(product|customer|supplier|order|board|receipt|ledger|transaction)_(?:update|delete|move|receive|outbound|void)$/.exec(input.action);
  let target;
  if (targetMatch && params.id !== undefined) {
    const kind = targetMatch[1];
    const [resource, getter] = ({ product: ['products', 'listProducts'], customer: ['customers', 'listCustomers'], supplier: ['suppliers', 'listSuppliers'], order: ['orders', 'listOrders'], board: ['boards', 'listBoards'], receipt: ['delivery_notes', 'listDeliveryNotes'], ledger: ['ledger', 'listLedger'], transaction: ['transactions', 'listTx'] })[kind];
    const rows = db[getter]();
    target = rows.find(row => String(row.id) === String(params.id) && (typeof row.id === 'string' || !row.deleted_at) && !row.voided_at);
    if (!target) {
      const resourceName = resources[resource][0];
      issues.push(`未找到有效的${resourceName}记录，请从下方列表选择`);
      params.id = undefined;
      issues.candidates ||= [];
      issues.candidates.push({ path: 'id', kind, items: rows.filter(row => !row.deleted_at && !row.voided_at).slice(0, 20).map(row => ({ id: row.id, name: row.name || row.product_name || row.order_no || row.work_order_no || `${resourceName} ${row.id}`, ...(row.specification ? { specification: row.specification } : {}), ...(row.stock !== undefined ? { stock: row.stock, unit: row.unit } : {}) })) });
    }
  }
  if (input.action === 'settlement' && (params.id !== undefined || params.party_name)) {
    const getter = params.party_type === 'customer' ? 'listCustomers' : 'listSuppliers';
    const rows = db[getter]().filter(row => !row.deleted_at && (params.id === undefined || row.id === params.id) && (!params.party_name || row.name === params.party_name));
    if (rows.length !== 1) {
      issues.push(`${params.party_type === 'customer' ? '客户' : '供应商'}${rows.length ? '名称重复，请选择编号' : '未找到，请核对名称或编号'}`);
      params.id = undefined;
      issues.candidates ||= [];
      const search = String(params.party_name || '').toLowerCase();
      const suggestions = rows.length ? rows : db[getter]().filter(row => !row.deleted_at && search && row.name.toLowerCase().includes(search));
      issues.candidates.push({ path: 'id', kind: params.party_type, items: suggestions.slice(0, 20).map(row => ({ id: row.id, name: row.name, stock: row[params.party_type === 'customer' ? 'debt' : 'payable'] })) });
    } else { params.id = rows[0].id; params.party_name = rows[0].name; }
  }
  const fields = missing(params, tool.schema);
  const nextIntent = { action: input.action, parameters: params };
  if (fields.length || issues.length) return { status: 'needs_input', title: tool.title, reply: [...issues, ...(fields.length ? [`请补充：${fields.join('、')}`] : [])].join('；'), intent: nextIntent, missing_fields: fields, candidates: issues.candidates || [], schema: tool.schema };
  validate(params, tool.schema);
  if (tool.mode === 'read') return { status: 'result', reply: '已查询到以下记录', intent: nextIntent, result: tool.run(db, params) };
  if (tool.mode === 'navigate') return { status: 'navigate', reply: `可以打开${pages[params.page]}`, intent: nextIntent, navigation: tool.run(db, params) };
  return { status: 'ready', title: tool.title, reply: `已整理${tool.title}的内容，请核对后提交`, intent: nextIntent, command: nextIntent, schema: tool.schema, preview: { parameters: params, ...(target ? { record: target } : {}) }, destructive: !!tool.destructive };
}
function run(db, input, actor) {
  const plan = prepare(db, input);
  if (plan.status === 'needs_input') throw fail(plan.reply);
  const tool = get(input.action);
  if (tool.mode === 'print') return tool.run(db, plan.command.parameters);
  if (tool.mode !== 'write') return plan;
  const result = tool.run(db, plan.command.parameters, actor);
  return { status: 'completed', action: input.action, reply: `${tool.title}成功`, result, ...(result?.id ? { id: result.id } : {}) };
}
function definitions(forModel = false) {
  const partial = schema => ({ ...schema, ...(schema.type === 'object' ? { required: [], properties: Object.fromEntries(Object.entries(schema.properties).map(([key, field]) => [key, partial(field)])) } : {}), ...(schema.items ? { items: partial(schema.items) } : {}) });
  return [...catalog.values()].map(tool => ({ type: 'function', function: {
    name: `${forModel ? 'prepare' : 'warehouse'}_${tool.action}`, description: `${tool.title}。${forModel ? '仅提取参数，缺少字段省略，不能编造或声称已执行。' : '通过仓库接口执行。'}`,
    parameters: forModel ? partial(tool.schema) : obj({ action: { type: 'string', enum: [tool.action] }, parameters: tool.schema }, ['action', 'parameters'])
  } }));
}
function capabilities() { return [...catalog.values()].map(({ action, title, mode, schema, destructive }) => ({ action, title, mode, schema, destructive: !!destructive })); }
function rules(message) {
  const match = /^(?:请)?(?:帮我)?(?:查询|查看|查一下|看看)(商品库存|库存|客户|供应商|订单|出入库流水|流水|账本|纸板库存|纸板批次|送货单|盘点|统计)(?:\s+(.+))?$/.exec(message.trim());
  if (match) return { action: 'query', parameters: { resource: ({ 商品库存: 'products', 库存: 'products', 客户: 'customers', 供应商: 'suppliers', 订单: 'orders', 出入库流水: 'transactions', 流水: 'transactions', 账本: 'ledger', 纸板库存: 'boards', 纸板批次: 'boards', 送货单: 'delivery_notes', 盘点: 'stocktakes', 统计: 'stats' })[match[1]], ...(match[2] ? { keyword: match[2] } : {}) } };
  const page = Object.entries(pages).find(([key, title]) => message === `打开${title.split('/')[0]}`);
  return page ? { action: 'open_page', parameters: { page: page[0] } } : null;
}
module.exports = { get, intent, prepare, run, definitions, capabilities, rules, validate };
