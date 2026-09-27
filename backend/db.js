// 无扫码版仓库系统 - JSON 文件数据库
const fs = require('fs');
const path = require('path');
const { roundDecimal, numberValue, lineAmount, dimensions, localDate } = require('./stock-math');

const DB_PATH = process.env.WAREHOUSE_DATA_FILE || path.join(__dirname, 'data.json');
const INIT = {
  products: [],
  customers: [],
  suppliers: [],
  transactions: [],
  ledger: [],
  orders: [],
  order_events: [],
  stocktakes: [],
  delivery_notes: [],
  _meta: { nextProductId: 1, nextCustomerId: 1, nextSupplierId: 1, nextTransactionId: 1, nextLedgerId: 1, nextDeliveryNoteId: 1 }
};

function load() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`数据库文件不存在: ${DB_PATH}`);
  try {
    const d = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    if (!d._meta) d._meta = { nextProductId: (d.products||[]).length+1, nextCustomerId: (d.customers||[]).length+1, nextTransactionId: (d.transactions||[]).length+1 };
    if (!d._meta.nextCustomerId) d._meta.nextCustomerId = (d.customers||[]).length+1;
    if (!d._meta.nextSupplierId) d._meta.nextSupplierId = (d.suppliers||[]).length+1;
    if (!Array.isArray(d.products)) throw new Error('数据库 products 字段损坏');
    if (!Array.isArray(d.customers) || !Array.isArray(d.suppliers) || !Array.isArray(d.transactions) || !Array.isArray(d.ledger)) throw new Error('数据库数组字段损坏');
    if (!Array.isArray(d.orders)) d.orders = [];
    if (!Array.isArray(d.order_events)) d.order_events = [];
    if (!Array.isArray(d.stocktakes)) d.stocktakes = [];
    if (!Array.isArray(d.delivery_notes)) d.delivery_notes = [];
    if (!d._meta.nextLedgerId) d._meta.nextLedgerId = d.ledger.length + 1;
    for (const [collection, counter] of [['products','nextProductId'],['customers','nextCustomerId'],['suppliers','nextSupplierId'],['transactions','nextTransactionId'],['ledger','nextLedgerId']]) {
      d._meta[counter] = d[collection].reduce((next, row) => Math.max(next, Number(row.id) + 1), Number(d._meta[counter]) || 1);
    }
    d.customers.forEach(c => { if (typeof c.debt !== 'number') c.debt = 0; });
    d.suppliers.forEach(s => { if (typeof s.payable !== 'number') s.payable = 0; });
    d.products.forEach(p => { if (p.specification === undefined) p.specification = ''; if (p.material === undefined) p.material = ''; if (p.corrugation === undefined) p.corrugation = ''; if (p.weight === undefined) p.weight = 0; if (p.length === undefined) p.length = 0; if (p.width === undefined) p.width = 0; if (p.layers === undefined) p.layers = 0; if (p.deleted_at === undefined) p.deleted_at = null; if (p.unit === undefined) p.unit = '件'; if (typeof p.price !== 'number') p.price = Number(p.price) || 0; });
    d.transactions.forEach(t => {
      if (t.specification === undefined) t.specification = '';
      if (t.material === undefined) t.material = '';
      if (t.unit === undefined) t.unit = '';
      if (typeof t.unit_price !== 'number') t.unit_price = Number(t.unit_price) || 0;
      if (typeof t.amount !== 'number') t.amount = Number(t.amount) || (Number(t.quantity)||0) * t.unit_price;
      if (t.product_name === undefined) t.product_name = d.products.find(p => p.id === Number(t.product_id))?.name || '';
    });
    d.stocktakes.forEach(t => { if (t.counted_at === undefined) t.counted_at = Number(t.created_at) || Date.now(); });
    if (!d._meta.nextDeliveryNoteId) d._meta.nextDeliveryNoteId = d.delivery_notes.length + 1;
    d._meta.nextDeliveryNoteId = d.delivery_notes.reduce((next, row) => Math.max(next, Number(row.id) + 1), Number(d._meta.nextDeliveryNoteId) || 1);
    return d;
  } catch (e) { throw new Error(`数据库读取失败，已保护原文件: ${e.message}`); }
}
function listLedger(f={}) {
  let l = cache.ledger.filter(x => f.include_voided === 'true' || !x.voided_at);
  if (f.type) l = l.filter(x => x.type === f.type);
  if (f.keyword) { const k=String(f.keyword).toLowerCase(); l=l.filter(x => String(x.remark||'').toLowerCase().includes(k) || String(x.party_name||'').toLowerCase().includes(k)); }
  if (f.from) l=l.filter(x=>x.created_at>=Number(f.from)); if(f.to) l=l.filter(x=>x.created_at<=Number(f.to) + 86399999);
  return l.sort((a,b)=>b.created_at-a.created_at);
}
function addLedger(d) {
  const amount=Number(d.amount); if (!Number.isFinite(amount)||amount<=0) throw new Error('金额必须大于 0');
  const allowed=['income','expense','receivable','payable','settlement']; if(!allowed.includes(d.type)) throw new Error('流水类型无效');
  const x={id:cache._meta.nextLedgerId++,type:d.type,amount,remark:String(d.remark||'').trim(),party_id:d.party_id?Number(d.party_id):null,party_name:String(d.party_name||'').trim(),transaction_id:d.transaction_id?Number(d.transaction_id):null,created_at:Date.now()}; cache.ledger.push(x); persist(); return x;
}
function deleteLedger(id) {
  const entry = cache.ledger.find(x => x.id === Number(id));
  if (!entry || entry.voided_at) throw new Error('账本记录不存在或已作废');
  if (entry.transaction_id) throw new Error('出入库生成的账务请通过原单作废');
  entry.voided_at = Date.now(); persist(); return entry;
}
function systemLedger(type, amount, partyId, partyName, transactionId, remark) {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const entry = { id: cache._meta.nextLedgerId++, type, amount: Math.round(amount * 100) / 100, remark: String(remark || ''), party_id: partyId ? Number(partyId) : null, party_name: String(partyName || ''), transaction_id: transactionId ? Number(transactionId) : null, created_at: Date.now() };
  cache.ledger.push(entry); return entry;
}
function listOrders(){ return cache.orders.slice().sort((a,b)=>b.created_at-a.created_at); }
function listOrderEvents(orderId) {
  const id = Number(orderId);
  return cache.order_events.filter(event => event.order_id === id).sort((a,b) => b.created_at - a.created_at);
}
function addOrder(d){
  if(!String(d.order_no||'').trim()) throw new Error('订单号不能为空');
  const q=numberValue(d.quantity === undefined ? 1 : d.quantity, '订单数量', true), p=numberValue(d.unit_price === undefined ? 0 : d.unit_price, '订单单价');
  const status = d.status || '待生产';
  if (!ORDER_STATUSES.includes(status)) throw new Error('订单状态无效');
  const x={id:cache.orders.reduce((next, order) => Math.max(next, order.id + 1), Date.now()),order_no:String(d.order_no).trim(),customer_id:d.customer_id?Number(d.customer_id):null,customer_name:String(d.customer_name||''),specification:String(d.specification||''),material:String(d.material||''),quantity:q,unit:String(d.unit||'件'),unit_price:p,amount:lineAmount(q,p),delivery_date:String(d.delivery_date||''),status,remark:String(d.remark||''),created_at:Date.now()};cache.orders.push(x);persist();return x;
}
const ORDER_STATUSES = ['待生产', '生产中', '已发货', '已完成', '已取消'];
const ORDER_TRANSITIONS = { '待生产': ['生产中', '已取消'], '生产中': ['已发货', '已取消'], '已发货': ['已完成'], '已完成': [] };
function updateOrder(id,d){
  const x=cache.orders.find(o=>o.id===Number(id));
  if(!x)throw new Error('订单不存在');
  const before=x.status;
  if (d.order_no !== undefined && !String(d.order_no).trim()) throw new Error('订单号不能为空');
  if (d.quantity !== undefined) d.quantity = numberValue(d.quantity, '订单数量', true);
  if (d.unit_price !== undefined) d.unit_price = numberValue(d.unit_price, '订单单价');
  if (d.status !== undefined) {
    if (!ORDER_STATUSES.includes(d.status)) throw new Error('订单状态无效');
    if (d.status !== before && !(ORDER_TRANSITIONS[before] || []).includes(d.status)) throw new Error(`订单不能从「${before}」变更为「${d.status}」`);
  }
  Object.assign(x,d);
  if(d.quantity!==undefined||d.unit_price!==undefined)x.amount=lineAmount(Number(x.quantity)||0, Number(x.unit_price)||0);
  if(d.status&&d.status!==before)cache.order_events.push({id:Date.now(),order_id:x.id,from:before,to:d.status,created_at:Date.now()});
  persist();return x;
}
function parseDateValue(value, fallback = Date.now()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return date.getTime();
    throw new Error('日期格式无效');
  }
  const timestamp = new Date(text).getTime();
  if (Number.isFinite(timestamp)) return timestamp;
  throw new Error('日期格式无效');
}
function addStocktake(d){
  const p=getProduct(Number(d.product_id));
  if(!p)throw new Error('商品不存在');
  const counted=numberValue(d.counted_stock, '盘点库存');
  const before=p.stock,diff=counted-before,createdAt=Date.now(),countedAt=parseDateValue(d.counted_at, createdAt);
  p.stock=counted;p.updated_at=createdAt;
  const x={id:createdAt,product_id:p.id,product_name:p.name,before_stock:before,counted_stock:counted,diff,remark:String(d.remark||''),counted_at:countedAt,created_at:createdAt};
  cache.stocktakes.push(x);
  cache.transactions.push({id:cache._meta.nextTransactionId++,product_id:p.id,product_name:p.name,type:'adjustment',quantity:Math.abs(diff),operator:String(d.operator||''),remark:x.remark||'库存盘点',created_at:createdAt,specification:p.specification||'',material:p.material||'',unit:p.unit||'件',unit_price:Number(p.price)||0,amount:Math.round(Math.abs(diff)*(Number(p.price)||0)*100)/100,adjustment:diff});
  persist();return {product:p,stocktake:x};
}
function listStocktakes(f={}){let l=cache.stocktakes.slice();if(f.product_id)l=l.filter(x=>x.product_id===Number(f.product_id));return l.sort((a,b)=>b.created_at-a.created_at);}
function listDeliveryNotes(){return cache.delivery_notes.slice().sort((a,b)=>b.created_at-a.created_at);}
function getDeliveryNote(id){return cache.delivery_notes.find(note=>note.id===Number(id))||null;}
function addDeliveryNote(data) {
  if (!Array.isArray(data.lines) || !data.lines.length) throw new Error('至少添加一行商品');
  const now = Date.now(); const supplier = activeParty(data.supplier_id, 'supplier');
  const freight = numberValue(data.freight === undefined ? 0 : data.freight, '运费');
  const date = data.date === undefined ? localDate() : String(data.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('日期格式无效');
  const seen = new Set();
  const prepared = data.lines.map(raw => {
    const product = getProduct(Number(raw?.product_id));
    if (!product || product.deleted_at) throw new Error('请选择有效商品，入库不会自动创建商品');
    if (seen.has(product.id)) throw new Error('同一商品不能重复入库，请合并数量');
    seen.add(product.id);
    const quantity = numberValue(raw.quantity, '计划数量', true);
    const delivered = numberValue(raw.delivered_qty === undefined ? quantity : raw.delivered_qty, '实际入库数量', true);
    const values = stockValues(product, delivered, raw);
    const specification = String(raw.specification ?? product.specification ?? '').trim();
    const [length, width] = dimensions(specification, product);
    const square = roundDecimal(delivered * length * width / 1000000, 4);
    if (!Number.isFinite(square)) throw new Error('面积超出支持范围');
    return { product, quantity, delivered, ...values, specification, length, width, square };
  });
  return atomicMutation(() => {
    const note = { id: cache._meta.nextDeliveryNoteId++, date, work_order_no: String(data.work_order_no || '').trim(), supplier_id: supplier?.id || null, supplier_name: supplier?.name || '', driver_phone: String(data.driver_phone || '').trim(), vehicle_no: String(data.vehicle_no || '').trim(), operator: String(data.operator || '').trim(), freight, remark: String(data.remark || '').trim(), lines: [], total_square_meters: 0, total_amount: 0, created_at: now };
    for (const item of prepared) {
      const { product, quantity, delivered, unit, unitPrice, amount, specification, length, width, square } = item;
      const result = stockIn(product.id, delivered, note.operator, note.remark || `送货单 ${note.work_order_no}`, note.supplier_id, { specification, unit, unit_price: unitPrice, recorded_at: now, delivery_note_id: note.id, work_order_no: note.work_order_no, delivered_qty: delivered, square_meters: square });
      note.lines.push({ product_id: product.id, product_name: product.name, specification, unit, length, width, quantity, unit_price: unitPrice, delivered_qty: delivered, square_meters: square, amount, transaction_id: result.transaction.id });
      note.total_square_meters += square; note.total_amount += amount;
    }
    note.total_square_meters = roundDecimal(note.total_square_meters, 4);
    note.total_amount = roundDecimal(note.total_amount, 2);
    // Freight is recorded separately; it does not increase supplier goods payable.
    cache.delivery_notes.push(note); persist(); return note;
  });
}
let cache = load();
let batching = false;
function atomicMutation(action) {
  if (batching) return action();
  const before = JSON.stringify(cache);
  batching = true;
  try { const result = action(); batching = false; persist(); return result; }
  catch (error) { cache = JSON.parse(before); throw error; }
  finally { batching = false; }
}
function persist() {
  if (batching) return;
  const tmp = `${DB_PATH}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(cache, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, DB_PATH);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

function revision() { return cache._collaboration?.revision || 0; }
function audit() { return cache._collaboration?.audit || []; }
// The service has one Node process; synchronous mutations and one atomic file replacement
// commit the stock, balances, audit entry and idempotency receipt together.
function transact(actor, key, fingerprint, expected, operation, action) {
  const previous = JSON.stringify(cache);
  const state = cache._collaboration || { revision: 0, audit: [], receipts: {} };
  const receiptKey = `${actor.id}:${key}`;
  const receipt = state.receipts[receiptKey];
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw Object.assign(new Error('重复请求编号对应不同内容'), { status: 409 });
    return { data: receipt.data, revision: revision(), replayed: true };
  }
  if (expected !== String(revision())) throw Object.assign(new Error('数据已被其他人更新，请刷新后重新提交'), { status: 409 });
  batching = true;
  try {
    cache._collaboration = state;
    const data = action();
    for (const [collection, field] of [['products','stock'], ['products','price'], ['customers','debt'], ['suppliers','payable'], ['orders','quantity'], ['orders','amount']]) {
      if (cache[collection].some(row => row[field] !== undefined && (!Number.isFinite(row[field]) || row[field] < 0))) throw new Error('数量、库存或金额无效');
    }
    state.revision++;
    state.audit.push({ id: state.revision, actor_id: actor.id, actor_name: actor.username, operation, time: Date.now(), record_id: data?.id || data?.transaction?.id || null });
    state.receipts[receiptKey] = { fingerprint, data: JSON.parse(JSON.stringify(data)), time: Date.now() };
    for (const k of Object.keys(state.receipts)) if (state.receipts[k].time < Date.now() - 7 * 86400000) delete state.receipts[k];
    batching = false;
    persist();
    return { data, revision: state.revision, replayed: false };
  } catch (error) { cache = JSON.parse(previous); throw error; }
  finally { batching = false; }
}

function listProducts(f={}) {
  let l = cache.products.filter(p => !p.deleted_at).slice();
  if (f.keyword) {
    const k = String(f.keyword).toLowerCase();
    l = l.filter(p => p.name.toLowerCase().includes(k) || (p.category&&p.category.toLowerCase().includes(k)) || (p.specification&&p.specification.toLowerCase().includes(k)) || (p.material&&p.material.toLowerCase().includes(k)));
  }
  l.sort((a,b) => (b.updated_at||0)-(a.updated_at||0));
  return l;
}
function getProduct(id) { return cache.products.find(p => p.id===id) || null; }

function addProduct(d) {
  if (!String(d.name || '').trim()) throw new Error('商品名称不能为空');
  const numeric = (value, label, fallback = 0) => value === undefined ? fallback : numberValue(value, label);
  const now = Date.now();
  const p = {
    id: cache._meta.nextProductId++,
    name: d.name,
    category: d.category || '',
    specification: d.specification || d.spec || '',
    material: d.material || '', corrugation: d.corrugation || '', weight: numeric(d.weight, '克重'), length: numeric(d.length, '长度'), width: numeric(d.width, '宽度'), layers: numeric(d.layers, '层数'),
    unit: String(d.unit || '件').trim(),
    price: numeric(d.price, '单价'),
    stock: numeric(d.stock, '初始库存'),
    safety_stock: numeric(d.safety_stock, '安全库存'),
    supplier_id: null,
    supplier_name: '',
    created_at: now, updated_at: now
  };
  if (d.supplier_id) { const s = getSupplier(Number(d.supplier_id)); if (s) { p.supplier_id = s.id; p.supplier_name = s.name; } }
  cache.products.push(p); persist(); return p;
}
function updateProduct(id, d) {
  const p = getProduct(id); if (!p) throw new Error('商品不存在');
  if (d.name!==undefined) { if (!d.name) throw new Error('名称不能为空'); p.name=d.name; }
  if (d.category!==undefined) p.category = d.category;
  if (d.specification!==undefined || d.spec!==undefined) p.specification = d.specification ?? d.spec ?? '';
  if (d.material!==undefined) p.material = d.material;
  if (d.corrugation!==undefined) p.corrugation = String(d.corrugation || '');
  if (d.weight!==undefined) p.weight = numberValue(d.weight, '克重');
  if (d.length!==undefined) p.length = numberValue(d.length, '长度');
  if (d.width!==undefined) p.width = numberValue(d.width, '宽度');
  if (d.layers!==undefined) p.layers = numberValue(d.layers, '层数');
  if (d.image_url!==undefined) p.image_url = String(d.image_url || '');
  if (d.unit!==undefined) p.unit = d.unit;
  if (d.price!==undefined) p.price = numberValue(d.price, '单价');
  if (d.safety_stock!==undefined) p.safety_stock = numberValue(d.safety_stock, '安全库存');
  if (d.supplier_id !== undefined) {
    const s = d.supplier_id ? getSupplier(Number(d.supplier_id)) : null;
    p.supplier_id = s ? s.id : null;
    p.supplier_name = s ? s.name : '';
  }
  p.updated_at = Date.now(); persist(); return p;
}
function deleteProduct(id) {
  const i = cache.products.findIndex(p => p.id===id);
  if (i===-1) throw new Error('商品不存在');
  cache.products[i].deleted_at = Date.now();
  cache.products[i].updated_at = Date.now();
  persist(); return true;
}

// ============ 客户 ============
function listCustomers(f={}) {
  let l = cache.customers.filter(c => !c.deleted_at).slice();
  if (f.keyword) {
    const k = String(f.keyword).toLowerCase();
    l = l.filter(c => c.name.toLowerCase().includes(k)
      || (c.phone && c.phone.toLowerCase().includes(k))
      || (c.contact && c.contact.toLowerCase().includes(k)));
  }
  l.sort((a,b) => (b.updated_at||0)-(a.updated_at||0));
  return l;
}
function getCustomer(id) { return cache.customers.find(c => c.id===id) || null; }
function addCustomer(d) {
  if (!d.name || !String(d.name).trim()) throw new Error('客户名称不能为空');
  const debt = d.debt === undefined ? 0 : numberValue(d.debt, '期初应收');
  const now = Date.now();
  const c = {
    id: cache._meta.nextCustomerId++,
    name: String(d.name).trim(),
    contact: d.contact || '',
    phone: d.phone || '',
    address: d.address || '',
    remark: d.remark || '',
    debt,
    created_at: now, updated_at: now
  };
  cache.customers.push(c); persist(); return c;
}
function updateCustomer(id, d) {
  const c = getCustomer(id); if (!c) throw new Error('客户不存在');
  if (d.name!==undefined) { if (!String(d.name).trim()) throw new Error('名称不能为空'); c.name = String(d.name).trim(); }
  if (d.contact!==undefined) c.contact = d.contact;
  if (d.phone!==undefined) c.phone = d.phone;
  if (d.address!==undefined) c.address = d.address;
  if (d.remark!==undefined) c.remark = d.remark;
  if (d.debt!==undefined) {
    const before = numberValue(c.debt, '应收余额');
    c.debt = numberValue(d.debt, '应收余额');
    if (c.debt < before) systemLedger('settlement', Math.round((before - c.debt) * 100) / 100, c.id, c.name, null, `客户欠款结清 · ${c.name}`);
  }
  c.updated_at = Date.now(); persist(); return c;
}
function deleteCustomer(id) {
  const i = cache.customers.findIndex(c => c.id===id);
  if (i===-1) throw new Error('客户不存在');
  cache.customers[i].deleted_at = Date.now();
  cache.customers[i].updated_at = Date.now();
  persist(); return true;
}

// ============ 供应商 ============
function listSuppliers(f={}) {
  let l = cache.suppliers.filter(s => !s.deleted_at).slice();
  if (f.keyword) {
    const k = String(f.keyword).toLowerCase();
    l = l.filter(s => s.name.toLowerCase().includes(k) || (s.phone && s.phone.toLowerCase().includes(k)) || (s.contact && s.contact.toLowerCase().includes(k)));
  }
  l.sort((a,b) => (b.updated_at||0)-(a.updated_at||0));
  return l;
}
function getSupplier(id) { return cache.suppliers.find(s => s.id===id) || null; }
function addSupplier(d) {
  if (!d.name || !String(d.name).trim()) throw new Error('供应商名称不能为空');
  const payable = d.payable === undefined ? 0 : numberValue(d.payable, '期初应付');
  const now = Date.now();
  const s = { id: cache._meta.nextSupplierId++, name: String(d.name).trim(), contact:d.contact||'', phone:d.phone||'', address:d.address||'', remark:d.remark||'', payable, created_at:now, updated_at:now };
  cache.suppliers.push(s); persist(); return s;
}
function updateSupplier(id,d) {
  const s = getSupplier(id); if (!s) throw new Error('供应商不存在');
  if (d.name!==undefined) { if (!String(d.name).trim()) throw new Error('名称不能为空'); s.name=String(d.name).trim(); }
  if (d.contact!==undefined) s.contact=d.contact; if (d.phone!==undefined) s.phone=d.phone; if (d.address!==undefined) s.address=d.address; if (d.remark!==undefined) s.remark=d.remark;
  if (d.payable!==undefined) {
    const before = numberValue(s.payable, '应付余额');
    s.payable = numberValue(d.payable, '应付余额');
    if (s.payable < before) systemLedger('settlement', Math.round((before - s.payable) * 100) / 100, s.id, s.name, null, `供应商应付款结清 · ${s.name}`);
  }
  cache.products.forEach(p => { if (p.supplier_id===id) p.supplier_name=s.name; });
  cache.transactions.forEach(t => { if (t.supplier_id===id) t.supplier_name=s.name; });
  s.updated_at=Date.now(); persist(); return s;
}
function deleteSupplier(id) {
  const i=cache.suppliers.findIndex(s=>s.id===id); if(i===-1) throw new Error('供应商不存在');
  cache.suppliers[i].deleted_at = Date.now(); cache.suppliers[i].updated_at = Date.now(); persist(); return true;
}

// 解析客户快照（出库/入库时记录客户名，防止客户改名/删除后历史失真）
function activeParty(id, type) {
  if (id === undefined || id === null || id === '') return null;
  const value = numberValue(id, '往来对象', true);
  const party = Number.isInteger(value) ? (type === 'supplier' ? getSupplier(value) : getCustomer(value)) : null;
  if (!party || party.deleted_at) throw new Error(`${type === 'supplier' ? '供应商' : '客户'}不存在或已停用`);
  return party;
}
function stockValues(product, quantity, details) {
  const qty = numberValue(quantity, '数量', true);
  const rawPrice = details.unit_price !== undefined ? details.unit_price : details.price !== undefined ? details.price : product.price;
  const unitPrice = numberValue(rawPrice, '单价');
  const unit = product.unit || '件';
  if (details.unit !== undefined && details.unit !== unit) throw new Error(`单位必须与商品库存单位「${unit}」一致`);
  return { qty, unitPrice, unit, amount: lineAmount(qty, unitPrice) };
}
function postStock(type, productId, quantity, op, remark, partyId, details) {
  const id = numberValue(productId, '商品编号', true);
  const product = Number.isInteger(id) ? getProduct(id) : null;
  if (!product || product.deleted_at) throw new Error('商品不存在或已停用');
  const { qty, unitPrice, unit, amount } = stockValues(product, quantity, details);
  const incoming = type === 'in'; const label = incoming ? '入库' : '出库';
  const party = activeParty(partyId, incoming ? 'supplier' : 'customer');
  if (!incoming && roundDecimal(product.stock, 6) < qty) throw new Error(`库存不足！${product.name} 当前库存：${product.stock}${unit}，需出库：${qty}${unit}`);
  const after = roundDecimal(product.stock + (incoming ? qty : -qty), 6);
  numberValue(after, '库存');
  return atomicMutation(() => {
    const createdAt = Number(details.recorded_at) || Date.now();
    product.stock = after; product.updated_at = createdAt;
    const tx = { id: cache._meta.nextTransactionId++, product_id: product.id, product_name: product.name, type, quantity: qty, operator: String(op || ''), remark: String(remark || ''), created_at: createdAt, specification: details.specification ?? product.specification ?? '', material: details.material ?? product.material ?? '', unit, unit_price: unitPrice, amount };
    tx[incoming ? 'supplier_id' : 'customer_id'] = party?.id || null;
    tx[incoming ? 'supplier_name' : 'customer_name'] = party?.name || '';
    for (const field of ['corrugation', 'weight', 'length', 'width', 'layers']) tx[field] = product[field];
    for (const field of ['delivery_note_id', 'work_order_no', 'delivered_qty', 'square_meters']) if (details[field] !== undefined) tx[field] = details[field];
    if (party) {
      const balance = incoming ? 'payable' : 'debt';
      party[balance] = roundDecimal(Number(party[balance] || 0) + amount, 2);
      systemLedger(incoming ? 'payable' : 'receivable', amount, party.id, party.name, tx.id, `${label}${incoming ? '应付款' : '应收款'} · ${product.name}`);
    }
    cache.transactions.push(tx); persist(); return { product, transaction: tx };
  });
}
function stockIn(productId, qty, op='', rmk='', supplierId=null, details={}) { return postStock('in', productId, qty, op, rmk, supplierId, details); }
function stockOut(productId, qty, op='', rmk='', customerId=null, details={}) { return postStock('out', productId, qty, op, rmk, customerId, details); }

function listTx(f={}) {
  let l = cache.transactions.filter(t => f.include_voided === 'true' || !t.voided_at);
  if (f.type) l = l.filter(t => t.type===f.type);
  if (f.product_id) l = l.filter(t => t.product_id===Number(f.product_id));
  if (f.customer_id) l = l.filter(t => t.customer_id===Number(f.customer_id));
  if (f.supplier_id) l = l.filter(t => t.supplier_id===Number(f.supplier_id));
  if (f.from) l = l.filter(t => t.created_at >= Number(f.from));
  if (f.to) l = l.filter(t => t.created_at <= Number(f.to) + 86399999);
  if (f.keyword) {
    const k = String(f.keyword).toLowerCase();
    l = l.filter(t => {
      const p = getProduct(t.product_id);
      return (p && p.name.toLowerCase().includes(k))
        || (t.remark && t.remark.toLowerCase().includes(k))
        || (t.customer_name && t.customer_name.toLowerCase().includes(k))
        || (t.supplier_name && t.supplier_name.toLowerCase().includes(k));
    });
  }
  l.sort((a,b) => b.created_at-a.created_at);
  return l.map(t => t.product_name === undefined ? { ...t, product_name: getProduct(t.product_id)?.name || '' } : t);
}
function reverseTransaction(tx) {
  if (tx.voided_at) throw new Error('记录已作废，不能重复作废');
  const p = getProduct(tx.product_id);
  if (!p) throw new Error('原商品不存在，无法安全恢复库存');
  if (tx.type === 'adjustment') throw new Error('盘点调整记录不能直接作废，请重新盘点修正');
  if (tx.type === 'in' && roundDecimal(p.stock, 6) < tx.quantity) throw new Error('无法作废：当前库存已低于该入库数量，可能已被后续出库使用');
  const party = tx.type === 'in' ? getSupplier(tx.supplier_id) : getCustomer(tx.customer_id);
  if (party) {
    const field = tx.type === 'in' ? 'payable' : 'debt';
    if (roundDecimal(Number(party[field] || 0), 2) < Number(tx.amount || 0)) throw new Error('该往来款已部分结算，请先核对退款或结算记录后再作废');
    party[field] = roundDecimal(Number(party[field] || 0) - Number(tx.amount || 0), 2);
  }
  p.stock = roundDecimal(p.stock + (tx.type === 'in' ? -tx.quantity : tx.quantity), 6); p.updated_at = Date.now();
  tx.voided_at = Date.now();
  cache.ledger.forEach(entry => { if (entry.transaction_id === tx.id) entry.voided_at = tx.voided_at; });
  return { id: tx.id, product_id: tx.product_id, type: tx.type, quantity: tx.quantity, voided_at: tx.voided_at };
}
function deleteTransaction(id) {
  const tx = cache.transactions.find(t => t.id === Number(id));
  if (!tx) throw new Error('交易记录不存在');
  if (tx.delivery_note_id) throw new Error('送货单明细请从入库页面整单作废，不能单独删除');
  return atomicMutation(() => { const result = reverseTransaction(tx); persist(); return result; });
}
function voidDeliveryNote(id) {
  const note = getDeliveryNote(id);
  if (!note || note.voided_at) throw new Error('送货单不存在或已作废');
  return atomicMutation(() => {
    for (const line of note.lines) {
      const tx = cache.transactions.find(item => item.id === line.transaction_id);
      if (!tx) throw new Error('送货单流水缺失，请核对历史数据');
      reverseTransaction(tx);
    }
    note.voided_at = Date.now(); persist(); return note;
  });
}
function stats() {
  const activeProducts = cache.products.filter(p => !p.deleted_at), activeCustomers = cache.customers.filter(c => !c.deleted_at), activeSuppliers = cache.suppliers.filter(s => !s.deleted_at);
  const totalProducts = activeProducts.length;
  const totalCustomers = activeCustomers.length;
  const totalSuppliers = activeSuppliers.length;
  const totalStock = activeProducts.reduce((s,p)=>s+p.stock,0);
  const totalValue = activeProducts.reduce((s,p)=>s+p.stock*p.price,0);
  const lowStock = activeProducts.filter(p => p.stock<=p.safety_stock).length;
  const today = new Date(); today.setHours(0,0,0,0); const ts = today.getTime();
  const todays = cache.transactions.filter(t => !t.voided_at && t.created_at>=ts);
  return { totalProducts, totalCustomers, totalSuppliers, totalStock, totalValue, lowStock,
    todayIn: todays.filter(t=>t.type==='in').reduce((s,t)=>s+t.quantity,0),
    todayOut: todays.filter(t=>t.type==='out').reduce((s,t)=>s+t.quantity,0) };
}

function stockOutBatch(lines, op='', rmk='', customerId=null) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('至少添加一项出库商品');
  activeParty(customerId, 'customer');
  const seen = new Set();
  const normalized = lines.map(line => {
    const id = numberValue(line?.product_id, '商品编号', true); const p = getProduct(id);
    if (!p || p.deleted_at) throw new Error('商品不存在或已停用');
    if (seen.has(id)) throw new Error('同一商品不能重复出库，请合并数量');
    seen.add(id); const { qty } = stockValues(p, line.quantity, line);
    if (roundDecimal(p.stock, 6) < qty) throw new Error(`库存不足！${p.name} 当前库存：${p.stock}${p.unit}，需出库：${qty}${p.unit}`);
    return { ...line, product_id: id, quantity: qty };
  });
  return atomicMutation(() => normalized.map(line => stockOut(line.product_id, line.quantity, op, line.remark || rmk, customerId, line)));
}

function backupData() { return JSON.parse(JSON.stringify(cache)); }
function restoreData(value) {
  if (!value || !Array.isArray(value.products) || !Array.isArray(value.customers) || !Array.isArray(value.suppliers) || !Array.isArray(value.transactions) || !Array.isArray(value.ledger)) throw new Error('备份文件格式无效');
  const next = JSON.parse(JSON.stringify(value));
  const collaboration = cache._collaboration || { revision: 0, audit: [], receipts: {} };
  next.orders = Array.isArray(next.orders) ? next.orders : []; next.order_events = Array.isArray(next.order_events) ? next.order_events : []; next.stocktakes = Array.isArray(next.stocktakes) ? next.stocktakes : []; next.delivery_notes = Array.isArray(next.delivery_notes) ? next.delivery_notes : [];
  if (!next._meta) next._meta = {};
  for (const [collection, counter] of [['products','nextProductId'],['customers','nextCustomerId'],['suppliers','nextSupplierId'],['transactions','nextTransactionId'],['ledger','nextLedgerId'],['delivery_notes','nextDeliveryNoteId']]) next._meta[counter] = next[collection].reduce((n, row) => Math.max(n, Number(row.id) + 1), Number(next._meta[counter]) || 1);
  next._collaboration = collaboration;
  cache = next; persist(); return stats();
}

module.exports = { listProducts, getProduct, addProduct, updateProduct, deleteProduct,
  listCustomers, getCustomer, addCustomer, updateCustomer, deleteCustomer,
  listSuppliers, getSupplier, addSupplier, updateSupplier, deleteSupplier,
  stockIn, stockOut, stockOutBatch, listTx, deleteTransaction, listLedger, addLedger, deleteLedger, listOrders, listOrderEvents, addOrder, updateOrder, addStocktake, listStocktakes, listDeliveryNotes, getDeliveryNote, addDeliveryNote, voidDeliveryNote, backupData, restoreData, stats, transact, revision, audit };
