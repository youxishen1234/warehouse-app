// 无扫码版仓库系统 - JSON 文件数据库
const fs = require('fs');
const path = require('path');

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
    d.products.forEach(p => { if (p.specification === undefined) p.specification = ''; if (p.material === undefined) p.material = ''; if (p.unit === undefined) p.unit = '件'; if (typeof p.price !== 'number') p.price = Number(p.price) || 0; });
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
  let l = cache.ledger.slice();
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
function deleteLedger(id){const i=cache.ledger.findIndex(x=>x.id===Number(id));if(i<0)throw new Error('账本记录不存在');const x=cache.ledger.splice(i,1)[0];persist();return x;}
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
function addOrder(d){ if(!String(d.order_no||'').trim()) throw new Error('订单号不能为空'); const q=Number(d.quantity)||0,p=Number(d.unit_price)||0; const x={id:cache.orders.reduce((next, order) => Math.max(next, order.id + 1), Date.now()),order_no:String(d.order_no).trim(),customer_id:d.customer_id?Number(d.customer_id):null,customer_name:String(d.customer_name||''),specification:String(d.specification||''),material:String(d.material||''),quantity:q,unit:String(d.unit||'件'),unit_price:p,amount:Math.round(q*p*100)/100,delivery_date:String(d.delivery_date||''),status:d.status||'待生产',remark:String(d.remark||''),created_at:Date.now()};cache.orders.push(x);persist();return x; }
function updateOrder(id,d){const x=cache.orders.find(o=>o.id===Number(id));if(!x)throw new Error('订单不存在');const before=x.status;Object.assign(x,d);if(d.quantity!==undefined||d.unit_price!==undefined)x.amount=Math.round((Number(x.quantity)||0)*(Number(x.unit_price)||0)*100)/100;if(d.status&&d.status!==before)cache.order_events.push({id:Date.now(),order_id:x.id,from:before,to:d.status,created_at:Date.now()});persist();return x;}
function parseDateValue(value, fallback = Date.now()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const timestamp = new Date(`${text}T00:00:00`).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  const timestamp = new Date(text).getTime();
  if (Number.isFinite(timestamp)) return timestamp;
  throw new Error('日期格式无效');
}
function addStocktake(d){
  const p=getProduct(Number(d.product_id));
  if(!p)throw new Error('商品不存在');
  const counted=Number(d.counted_stock);
  if(!Number.isFinite(counted)||counted<0)throw new Error('盘点库存无效');
  const before=p.stock,diff=counted-before,createdAt=Date.now(),countedAt=parseDateValue(d.counted_at, createdAt);
  p.stock=counted;p.updated_at=createdAt;
  const x={id:createdAt,product_id:p.id,product_name:p.name,before_stock:before,counted_stock:counted,diff,remark:String(d.remark||''),counted_at:countedAt,created_at:createdAt};
  cache.stocktakes.push(x);
  cache.transactions.push({id:cache._meta.nextTransactionId++,product_id:p.id,product_name:p.name,type:'adjustment',quantity:Math.abs(diff),operator:String(d.operator||''),remark:x.remark||'库存盘点',created_at:createdAt,specification:p.specification||'',material:p.material||'',unit:p.unit||'件',unit_price:Number(p.price)||0,amount:Math.round(Math.abs(diff)*(Number(p.price)||0)*100)/100,adjustment:diff});
  persist();return {product:p,stocktake:x};
}
function listStocktakes(f={}){let l=cache.stocktakes.slice();if(f.product_id)l=l.filter(x=>x.product_id===Number(f.product_id));return l.sort((a,b)=>b.created_at-a.created_at);}
function parseDimensions(specification) { const m=String(specification||'').replace(/,/g,'').match(/(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)/); return m ? {length:Number(m[1]),width:Number(m[2])} : {length:0,width:0}; }
function listDeliveryNotes(){return cache.delivery_notes.slice().sort((a,b)=>b.created_at-a.created_at);}
function getDeliveryNote(id){return cache.delivery_notes.find(note=>note.id===Number(id))||null;}
function addDeliveryNote(data){
  const lines=Array.isArray(data.lines)?data.lines:[]; if(!lines.length)throw new Error('至少添加一行纸板');
  const now=Date.now(), supplier=data.supplier_id?getSupplier(Number(data.supplier_id)):null;
  const note={id:cache._meta.nextDeliveryNoteId++,date:String(data.date||new Date(now).toISOString().slice(0,10)),work_order_no:String(data.work_order_no||'').trim(),supplier_id:supplier?supplier.id:null,supplier_name:supplier?supplier.name:String(data.supplier_name||'').trim(),driver_phone:String(data.driver_phone||'').trim(),vehicle_no:String(data.vehicle_no||'').trim(),freight:Number(data.freight)||0,remark:String(data.remark||'').trim(),lines:[],total_square_meters:0,total_amount:0,created_at:now};
  for(const raw of lines){
    const specification=String(raw.specification||'').trim(), qty=Number(raw.quantity), delivered=raw.delivered_qty===undefined||raw.delivered_qty===''?qty:Number(raw.delivered_qty), unitPrice=Number(raw.unit_price)||0;
    if(!specification)throw new Error('规格/楞别不能为空'); if(!Number.isFinite(qty)||qty<=0||!Number.isFinite(delivered)||delivered<=0)throw new Error('数量和送货数必须大于 0'); if(!Number.isFinite(unitPrice)||unitPrice<0)throw new Error('单价格式无效');
    // Specification is millimeters, such as 1550×705/A: convert each side to meters.
    const dim=parseDimensions(specification), squareMeters=Math.round(qty*dim.length*dim.width/1000000*10000)/10000, amount=Math.round(qty*unitPrice*100)/100;
    let product=raw.product_id?getProduct(Number(raw.product_id)):null;
    if(!product)product=addProduct({name:String(raw.product_name||`纸板 ${specification}`),category:'纸板',specification,unit:'张',price:unitPrice,stock:0});
    const result=stockIn(product.id,delivered,String(data.operator||''),note.remark||`送货单 ${note.work_order_no}`,note.supplier_id,{specification,unit:'张',unit_price:unitPrice,amount,recorded_at:now,delivery_note_id:note.id,work_order_no:note.work_order_no,driver_phone:note.driver_phone,vehicle_no:note.vehicle_no,freight:note.freight,delivered_qty:delivered,square_meters:squareMeters});
    const line={product_id:product.id,product_name:product.name,specification,quantity:qty,unit_price:unitPrice,delivered_qty:delivered,square_meters:squareMeters,amount,transaction_id:result.transaction.id}; note.lines.push(line);note.total_square_meters+=squareMeters;note.total_amount+=amount;
  }
  note.total_square_meters=Math.round(note.total_square_meters*10000)/10000;note.total_amount=Math.round(note.total_amount*100)/100;cache.delivery_notes.push(note);persist();return note;
}
let cache = load();
let batching = false;
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
  let l = cache.products.slice();
  if (f.keyword) {
    const k = String(f.keyword).toLowerCase();
    l = l.filter(p => p.name.toLowerCase().includes(k) || (p.category&&p.category.toLowerCase().includes(k)) || (p.specification&&p.specification.toLowerCase().includes(k)) || (p.material&&p.material.toLowerCase().includes(k)));
  }
  l.sort((a,b) => (b.updated_at||0)-(a.updated_at||0));
  return l;
}
function getProduct(id) { return cache.products.find(p => p.id===id) || null; }

function addProduct(d) {
  if (!d.name) throw new Error('商品名称不能为空');
  const now = Date.now();
  const p = {
    id: cache._meta.nextProductId++,
    name: d.name,
    category: d.category || '',
    specification: d.specification || d.spec || '',
    material: d.material || '',
    unit: d.unit || '件',
    price: Number(d.price)||0,
    stock: Number(d.stock)||0,
    safety_stock: Number(d.safety_stock)||0,
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
  if (d.image_url!==undefined) p.image_url = String(d.image_url || '');
  if (d.unit!==undefined) p.unit = d.unit;
  if (d.price!==undefined) p.price = Number(d.price)||0;
  if (d.safety_stock!==undefined) p.safety_stock = Number(d.safety_stock)||0;
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
  cache.products.splice(i,1);
  cache.transactions = cache.transactions.filter(t => t.product_id!==id);
  persist(); return true;
}

// ============ 客户 ============
function listCustomers(f={}) {
  let l = cache.customers.slice();
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
  const now = Date.now();
  const c = {
    id: cache._meta.nextCustomerId++,
    name: String(d.name).trim(),
    contact: d.contact || '',
    phone: d.phone || '',
    address: d.address || '',
    remark: d.remark || '',
    debt: Math.max(0, Number(d.debt) || 0),
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
    const before = Math.max(0, Number(c.debt) || 0);
    c.debt = Math.max(0, Number(d.debt) || 0);
    if (c.debt < before) systemLedger('settlement', Math.round((before - c.debt) * 100) / 100, c.id, c.name, null, `客户欠款结清 · ${c.name}`);
  }
  c.updated_at = Date.now(); persist(); return c;
}
function deleteCustomer(id) {
  const i = cache.customers.findIndex(c => c.id===id);
  if (i===-1) throw new Error('客户不存在');
  cache.customers.splice(i,1);
  // 历史流水保留客户名称快照，仅解除关联
  cache.transactions.forEach(t => { if (t.customer_id===id) t.customer_id = null; });
  persist(); return true;
}

// ============ 供应商 ============
function listSuppliers(f={}) {
  let l = cache.suppliers.slice();
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
  const now = Date.now();
  const s = { id: cache._meta.nextSupplierId++, name: String(d.name).trim(), contact:d.contact||'', phone:d.phone||'', address:d.address||'', remark:d.remark||'', payable:Math.max(0, Number(d.payable)||0), created_at:now, updated_at:now };
  cache.suppliers.push(s); persist(); return s;
}
function updateSupplier(id,d) {
  const s = getSupplier(id); if (!s) throw new Error('供应商不存在');
  if (d.name!==undefined) { if (!String(d.name).trim()) throw new Error('名称不能为空'); s.name=String(d.name).trim(); }
  if (d.contact!==undefined) s.contact=d.contact; if (d.phone!==undefined) s.phone=d.phone; if (d.address!==undefined) s.address=d.address; if (d.remark!==undefined) s.remark=d.remark;
  if (d.payable!==undefined) {
    const before = Math.max(0, Number(s.payable) || 0);
    s.payable = Math.max(0, Number(d.payable) || 0);
    if (s.payable < before) systemLedger('settlement', Math.round((before - s.payable) * 100) / 100, s.id, s.name, null, `供应商应付款结清 · ${s.name}`);
  }
  cache.products.forEach(p => { if (p.supplier_id===id) p.supplier_name=s.name; });
  cache.transactions.forEach(t => { if (t.supplier_id===id) t.supplier_name=s.name; });
  s.updated_at=Date.now(); persist(); return s;
}
function deleteSupplier(id) {
  const i=cache.suppliers.findIndex(s=>s.id===id); if(i===-1) throw new Error('供应商不存在');
  cache.suppliers.splice(i,1); cache.products.forEach(p=>{if(p.supplier_id===id){p.supplier_id=null;p.supplier_name='';}}); cache.transactions.forEach(t=>{if(t.supplier_id===id)t.supplier_id=null;}); persist(); return true;
}

// 解析客户快照（出库/入库时记录客户名，防止客户改名/删除后历史失真）
function customerSnapshot(customerId) {
  if (!customerId) return { customer_id: null, customer_name: '' };
  const c = getCustomer(Number(customerId));
  return c ? { customer_id: c.id, customer_name: c.name } : { customer_id: null, customer_name: '' };
}

function stockIn(productId, qty, op='', rmk='', supplierId=null, details={}) {
  const p = getProduct(productId); if (!p) throw new Error('商品不存在');
  qty = Number(qty); if (!qty||qty<=0) throw new Error('入库数量必须大于 0');
  const recordedAt = Number(details.recorded_at) || Date.now();
  p.stock += qty; p.updated_at = recordedAt;
  const supplier = supplierId && getSupplier(Number(supplierId));
  const unit = details.unit || p.unit || '件'; const unitPrice = Number(details.unit_price ?? details.price ?? p.price) || 0; const amount = Number.isFinite(Number(details.amount)) ? Math.round(Number(details.amount) * 100) / 100 : Math.round(qty * unitPrice * 100) / 100;
  const tx = Object.assign({ id: cache._meta.nextTransactionId++, product_id: p.id, product_name: p.name, type:'in', quantity:qty, operator:op, remark:rmk, created_at:recordedAt, supplier_id: supplier ? supplier.id : null, supplier_name: supplier ? supplier.name : '', specification: details.specification ?? p.specification ?? '', material: details.material ?? p.material ?? '', unit, unit_price: unitPrice, amount });
  for (const field of ['delivery_note_id','work_order_no','driver_phone','vehicle_no','freight','delivered_qty','square_meters']) if (details[field] !== undefined) tx[field] = details[field];
  if (supplier && amount > 0) supplier.payable = Math.max(0, Number(supplier.payable)||0) + amount;
  cache.transactions.push(tx); if (supplier) systemLedger('payable', amount, supplier.id, supplier.name, tx.id, `入库应付款 · ${p.name}`); persist(); return { product:p, transaction:tx };
}
function stockOut(productId, qty, op='', rmk='', customerId=null, details={}) {
  const p = getProduct(productId); if (!p) throw new Error('商品不存在');
  qty = Number(qty); if (!qty||qty<=0) throw new Error('出库数量必须大于 0');
  if (p.stock < qty) throw new Error(`库存不足！当前库存：${p.stock}${p.unit}，需出库：${qty}${p.unit}`);
  p.stock -= qty; p.updated_at = Date.now();
  const cust = customerSnapshot(customerId);
  const unit = details.unit || p.unit || '件'; const unitPrice = Number(details.unit_price ?? details.price ?? p.price) || 0; const amount = Math.round(qty * unitPrice * 100) / 100;
  const tx = Object.assign({ id: cache._meta.nextTransactionId++, product_id: p.id, product_name: p.name, type:'out', quantity:qty, operator:op, remark:rmk, created_at:Date.now(), specification: details.specification ?? p.specification ?? '', material: details.material ?? p.material ?? '', unit, unit_price: unitPrice, amount }, cust);
  const customer = customerId && getCustomer(Number(customerId)); if (customer && amount > 0) customer.debt = Math.max(0, Number(customer.debt)||0) + amount;
  cache.transactions.push(tx); if (customer) systemLedger('receivable', amount, customer.id, customer.name, tx.id, `出库应收款 · ${p.name}`); persist(); return { product:p, transaction:tx };
}

function listTx(f={}) {
  let l = cache.transactions.slice();
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
function deleteTransaction(id) {
  id = Number(id);
  const idx = cache.transactions.findIndex(t => t.id === id);
  if (idx === -1) throw new Error('交易记录不存在');
  const tx = cache.transactions[idx];
  const p = getProduct(tx.product_id);
  if (tx.type === 'adjustment') throw new Error('盘点调整记录不能直接删除，请重新盘点修正');
  if (tx.type === 'in' && p && Number(p.stock) < Number(tx.quantity)) throw new Error('无法删除：当前库存已低于该入库数量，可能已被后续出库使用');
  if (tx.type === 'in' && tx.supplier_id) { const s = getSupplier(tx.supplier_id); if (s) s.payable = Math.max(0, Number(s.payable || 0) - Number(tx.amount || 0)); }
  if (tx.type === 'out' && tx.customer_id) { const c = getCustomer(tx.customer_id); if (c) c.debt = Math.max(0, Number(c.debt || 0) - Number(tx.amount || 0)); }
  cache.ledger = cache.ledger.filter(entry => entry.transaction_id !== tx.id);
  if (p) {
    if (tx.type === 'in') {
      p.stock -= tx.quantity;
    } else if (tx.type === 'out') {
      p.stock += tx.quantity;
    }
    p.updated_at = Date.now();
  }
  cache.transactions.splice(idx, 1);
  persist();
  return { id: tx.id, product_id: tx.product_id, type: tx.type, quantity: tx.quantity };
}
function stats() {
  const totalProducts = cache.products.length;
  const totalCustomers = cache.customers.length;
  const totalSuppliers = cache.suppliers.length;
  const totalStock = cache.products.reduce((s,p)=>s+p.stock,0);
  const totalValue = cache.products.reduce((s,p)=>s+p.stock*p.price,0);
  const lowStock = cache.products.filter(p => p.stock<=p.safety_stock).length;
  const today = new Date(); today.setHours(0,0,0,0); const ts = today.getTime();
  const todays = cache.transactions.filter(t => t.created_at>=ts);
  return { totalProducts, totalCustomers, totalSuppliers, totalStock, totalValue, lowStock,
    todayIn: todays.filter(t=>t.type==='in').reduce((s,t)=>s+t.quantity,0),
    todayOut: todays.filter(t=>t.type==='out').reduce((s,t)=>s+t.quantity,0) };
}

module.exports = { listProducts, getProduct, addProduct, updateProduct, deleteProduct,
  listCustomers, getCustomer, addCustomer, updateCustomer, deleteCustomer,
  listSuppliers, getSupplier, addSupplier, updateSupplier, deleteSupplier,
  stockIn, stockOut, listTx, deleteTransaction, listLedger, addLedger, deleteLedger, listOrders, listOrderEvents, addOrder, updateOrder, addStocktake, listStocktakes, listDeliveryNotes, getDeliveryNote, addDeliveryNote, stats, transact, revision, audit };
