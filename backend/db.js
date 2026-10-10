// 无扫码版仓库系统 - JSON 文件数据库
const fs = require('fs');
const path = require('path');
const { roundDecimal, numberValue, lineAmount, dimensions, localDate, MONEY_DECIMALS } = require('./stock-math');
const { ORDER_STATUSES } = require('./list-sort');
const { parseDateQuery } = require('./date-query');
const customerDimensions = require('./customer-dimensions');

const DB_PATH = process.env.WAREHOUSE_DATA_FILE || path.join(__dirname, 'data.json');
const ledgerAttachments = require('./ledger-attachments').createStore(DB_PATH);
const SCHEMA_VERSION = 1;
const BACKUP_DIR = process.env.WAREHOUSE_BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const AUTO_BACKUP_KEEP = Math.max(1, Math.min(100, Number(process.env.WAREHOUSE_BACKUP_KEEP) || 7));
const AUTO_BACKUP_MAX_DAYS = Math.max(1, Math.min(3650, Number(process.env.WAREHOUSE_BACKUP_MAX_DAYS) || 30));
let loadWarnings = [];
let migratedDimensions = false;

function normalizeTimestampFields(data) {
  const fields = ['created_at', 'updated_at', 'profile_updated_at', 'stock_updated_at', 'balance_updated_at', 'counted_at', 'voided_at'];
  const collections = ['products', 'customers', 'suppliers', 'transactions', 'ledger', 'orders', 'order_events', 'stocktakes', 'delivery_notes'];
  let converted = 0;
  for (const collection of collections) for (const row of data[collection] || []) for (const field of fields) {
    const value = row[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const numeric = Number(value);
    const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(value);
    if (Number.isSafeInteger(timestamp) && timestamp >= 0) {
      row[field] = timestamp;
      converted += 1;
    }
  }
  if (converted) loadWarnings.push(`timestamp migration converted ${converted} string values`);
  return converted;
}

function scanReferenceWarnings(data) {
  const warnings = [];
  const products = new Set((data.products || []).map(row => Number(row.id)));
  const customers = new Set((data.customers || []).map(row => Number(row.id)));
  const suppliers = new Set((data.suppliers || []).map(row => Number(row.id)));
  const transactions = new Set((data.transactions || []).map(row => Number(row.id)));
  const orders = new Set((data.orders || []).map(row => Number(row.id)));
  for (const row of data.transactions || []) {
    if (!products.has(Number(row.product_id))) warnings.push(`transaction:${row.id}:missing-product:${row.product_id}`);
    if (row.customer_id != null && !customers.has(Number(row.customer_id))) warnings.push(`transaction:${row.id}:missing-customer:${row.customer_id}`);
    if (row.supplier_id != null && !suppliers.has(Number(row.supplier_id))) warnings.push(`transaction:${row.id}:missing-supplier:${row.supplier_id}`);
  }
  for (const row of data.ledger || []) {
    if (row.transaction_id != null && !transactions.has(Number(row.transaction_id))) warnings.push(`ledger:${row.id}:missing-transaction:${row.transaction_id}`);
    if (row.party_id != null && !customers.has(Number(row.party_id)) && !suppliers.has(Number(row.party_id))) warnings.push(`ledger:${row.id}:missing-party:${row.party_id}`);
  }
  for (const row of data.stocktakes || []) if (!products.has(Number(row.product_id))) warnings.push(`stocktake:${row.id}:missing-product:${row.product_id}`);
  for (const row of data.order_events || []) if (!orders.has(Number(row.order_id))) warnings.push(`order-event:${row.id}:missing-order:${row.order_id}`);
  for (const note of data.delivery_notes || []) {
    if (note.supplier_id != null && !suppliers.has(Number(note.supplier_id))) warnings.push(`delivery-note:${note.id}:missing-supplier:${note.supplier_id}`);
    for (const line of note.lines || []) if (!products.has(Number(line.product_id))) warnings.push(`delivery-note:${note.id}:missing-product:${line.product_id}`);
  }
  return warnings.slice(0, 100);
}

function cleanupResidualTemps() {
  const directory = path.dirname(DB_PATH);
  const base = path.basename(DB_PATH);
  try {
    for (const name of fs.readdirSync(directory)) {
      if (name === `${base}.tmp` || name.startsWith(`${base}.tmp-`)) {
        try { fs.unlinkSync(path.join(directory, name)); } catch (error) { /* best effort during startup */ }
      }
    }
  } catch (error) { /* the normal load path reports a missing database */ }
}

function syncDirectory(directory) {
  try {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) { /* directory fsync is not available on every platform */ }
}

function rotateAutoBackups() {
  const now = Date.now();
  const cutoff = now - AUTO_BACKUP_MAX_DAYS * 86400000;
  let files = [];
  try { files = fs.readdirSync(BACKUP_DIR).filter(name => name.startsWith('warehouse-data-') && name.endsWith('.json')); } catch (error) { return; }
  const records = files.map(name => {
    try { return { name, mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }; } catch (error) { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  records.forEach((record, index) => {
    if (index >= AUTO_BACKUP_KEEP || record.mtime < cutoff) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, record.name)); } catch (error) { /* best effort cleanup */ }
    }
  });
}

function createAutoBackup(reason) {
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(BACKUP_DIR, 0o700); } catch (error) { /* Windows ACLs are managed by the host */ }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(BACKUP_DIR, `warehouse-data-${stamp}-${reason}.json`);
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    let snapshot;
    try { snapshot = JSON.parse(raw); } catch { /* Preserve corrupt databases for manual recovery. */ }
    fs.writeFileSync(target, snapshot ? JSON.stringify(ledgerAttachments.portable(snapshot)) : raw, { flag: 'wx', mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch (error) { /* best effort */ }
    rotateAutoBackups();
    return target;
  } catch (error) {
    console.warn('[db] automatic backup skipped:', error.message);
    return null;
  }
}

function load() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`数据库文件不存在: ${DB_PATH}`);
  try {
    const d = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    if (!d._meta) d._meta = { schemaVersion: SCHEMA_VERSION, nextProductId: (d.products||[]).length+1, nextCustomerId: (d.customers||[]).length+1, nextTransactionId: (d.transactions||[]).length+1 };
    const storedSchemaVersion = Number(d._meta?.schemaVersion) || 0;
    if (storedSchemaVersion > SCHEMA_VERSION) throw new Error('data file requires a newer schema version');
    if (!d._meta) d._meta = {};
    d._meta.schemaVersion = SCHEMA_VERSION;
    if (!d._meta.nextCustomerId) d._meta.nextCustomerId = (d.customers||[]).length+1;
    if (!d._meta.nextSupplierId) d._meta.nextSupplierId = (d.suppliers||[]).length+1;
    if (!d._meta.nextOrderEventId) d._meta.nextOrderEventId = (d.order_events||[]).length+1;
    if (!d._meta.nextOrderId) d._meta.nextOrderId = (d.orders||[]).length+1;
    if (!d._meta.nextStocktakeId) d._meta.nextStocktakeId = (d.stocktakes||[]).length+1;
    if (!Array.isArray(d.products)) throw new Error('数据库 products 字段损坏');
    if (!Array.isArray(d.customers) || !Array.isArray(d.suppliers) || !Array.isArray(d.transactions) || !Array.isArray(d.ledger)) throw new Error('数据库数组字段损坏');
    if (!Array.isArray(d.orders)) d.orders = [];
    if (!Array.isArray(d.order_events)) d.order_events = [];
    if (!Array.isArray(d.stocktakes)) d.stocktakes = [];
    if (!Array.isArray(d.delivery_notes)) d.delivery_notes = [];
    require('./print-notes').validateBackup(d);
    if (!d.print_notes) d.print_notes = [];
    if (!d._meta.nextLedgerId) d._meta.nextLedgerId = d.ledger.length + 1;
    for (const [collection, counter] of [['products','nextProductId'],['customers','nextCustomerId'],['suppliers','nextSupplierId'],['transactions','nextTransactionId'],['ledger','nextLedgerId'],['orders','nextOrderId'],['order_events','nextOrderEventId'],['stocktakes','nextStocktakeId']]) {
      if (!Array.isArray(d[collection])) d[collection] = [];
      d._meta[counter] = d[collection].reduce((next, row) => Math.max(next, Number(row.id) + 1), Number(d._meta[counter]) || 1);
    }
    d.customers.forEach(c => { if (typeof c.debt !== 'number') c.debt = 0; if (c.profile_updated_at === undefined) c.profile_updated_at = Number(c.updated_at) || Number(c.created_at) || 0; if (c.balance_updated_at === undefined) c.balance_updated_at = Number(c.updated_at) || Number(c.created_at) || 0; });
    d.suppliers.forEach(s => { if (typeof s.payable !== 'number') s.payable = 0; if (s.profile_updated_at === undefined) s.profile_updated_at = Number(s.updated_at) || Number(s.created_at) || 0; if (s.balance_updated_at === undefined) s.balance_updated_at = Number(s.updated_at) || Number(s.created_at) || 0; });
    d.products.forEach(p => { if (p.specification === undefined) p.specification = ''; if (p.material === undefined) p.material = ''; if (p.corrugation === undefined) p.corrugation = ''; if (p.weight === undefined) p.weight = 0; if (p.length === undefined) p.length = 0; if (p.width === undefined) p.width = 0; if (p.layers === undefined) p.layers = 0; if (p.deleted_at === undefined) p.deleted_at = null; if (p.unit === undefined) p.unit = '件'; if (typeof p.price !== 'number') p.price = Number(p.price) || 0; if (p.profile_updated_at === undefined) p.profile_updated_at = Number(p.updated_at) || Number(p.created_at) || 0; if (p.stock_updated_at === undefined) p.stock_updated_at = Number(p.updated_at) || Number(p.created_at) || 0; });
    d.transactions.forEach(t => {
      if (t.specification === undefined) t.specification = '';
      if (t.material === undefined) t.material = '';
      if (t.unit === undefined) t.unit = '';
      if (typeof t.unit_price !== 'number') t.unit_price = Number(t.unit_price) || 0;
      if (typeof t.amount !== 'number') t.amount = Number(t.amount) || (Number(t.quantity)||0) * t.unit_price;
      if (t.product_name === undefined) t.product_name = d.products.find(p => p.id === Number(t.product_id))?.name || '';
    });
    d.stocktakes.forEach(t => { if (t.counted_at === undefined) t.counted_at = Number(t.created_at) || Date.now(); });
    normalizeTimestampFields(d);
    if (!d._meta.nextDeliveryNoteId) d._meta.nextDeliveryNoteId = d.delivery_notes.length + 1;
    d._meta.nextDeliveryNoteId = d.delivery_notes.reduce((next, row) => Math.max(next, Number(row.id) + 1), Number(d._meta.nextDeliveryNoteId) || 1);
    if (d.customer_dimensions === undefined) {
      const legacyFiles = process.env.WAREHOUSE_DIMENSIONS_FILE ? [process.env.WAREHOUSE_DIMENSIONS_FILE] : [path.join(path.dirname(DB_PATH), 'customer-dimensions.json'), path.join(__dirname, 'customer-dimensions.json')];
      const legacyFile = legacyFiles.find(file => fs.existsSync(file));
      if (legacyFile) {
        d.customer_dimensions = customerDimensions.validateDocument(JSON.parse(fs.readFileSync(legacyFile, 'utf8')));
        migratedDimensions = true;
        loadWarnings.push('customer dimensions migrated into the warehouse database');
      } else d.customer_dimensions = customerDimensions.empty();
    } else d.customer_dimensions = customerDimensions.validateDocument(d.customer_dimensions);
    loadWarnings = loadWarnings.concat(scanReferenceWarnings(d));
    if (loadWarnings.length) console.warn(`[db] startup reference warnings: ${loadWarnings.length}`);
    return d;
  } catch (e) { throw new Error(`数据库读取失败，已保护原文件: ${e.message}`); }
}
function listLedger(f={}) {
  let l = cache.ledger.filter(x => f.include_voided === 'true' || !x.voided_at);
  if (f.type) l = l.filter(x => x.type === f.type);
  if (f.keyword) { const k=String(f.keyword).toLowerCase(); l=l.filter(x => String(x.remark||'').toLowerCase().includes(k) || String(x.party_name||'').toLowerCase().includes(k)); }
  const from = f.from === undefined ? undefined : parseDateQuery(String(f.from));
  const to = f.to === undefined ? undefined : parseDateQuery(String(f.to), true);
  if (from !== undefined) l=l.filter(x=>x.created_at>=from); if(to !== undefined) l=l.filter(x=>x.created_at<=to);
  const customers = new Map(cache.customers.map(party => [Number(party.id), String(party.name || '')]));
  const suppliers = new Map(cache.suppliers.map(party => [Number(party.id), String(party.name || '')]));
  return l.sort((a,b)=>b.created_at-a.created_at || b.id-a.id).map(entry => ({
    ...entry,
    // Keep the persisted party_name snapshot intact; current name is read-time
    // metadata so historical ledger rows remain auditable after a rename.
    party_current_name: entry.party_id == null ? '' : (ledgerPartyType(entry, { customers: cache.customers, suppliers: cache.suppliers }) === 'supplier'
      ? suppliers.get(Number(entry.party_id)) || '' : customers.get(Number(entry.party_id)) || '')
  }));
}
function moneyValue(value, label, positive = false) {
  return roundDecimal(numberValue(value, label, positive), 2);
}
function addLedger(d) {
  const amount=moneyValue(d.amount, '金额', true);
  const allowed=['income','expense','receivable','payable','settlement']; if(!allowed.includes(d.type)) throw new Error('流水类型无效');
  const partyType = d.party_type === 'customer' || d.party_type === 'supplier' ? d.party_type : d.type === 'receivable' ? 'customer' : d.type === 'payable' ? 'supplier' : null;
  const x={id:cache._meta.nextLedgerId++,type:d.type,amount,remark:String(d.remark||'').trim(),party_id:d.party_id?Number(d.party_id):null,party_type:partyType,party_name:String(d.party_name||'').trim(),transaction_id:d.transaction_id?Number(d.transaction_id):null,created_at:Date.now()}; cache.ledger.push(x); persist(); return x;
}
function deleteLedger(id) {
  const entry = cache.ledger.find(x => x.id === Number(id));
  if (!entry || entry.voided_at) throw new Error('账本记录不存在或已作废');
  if (entry.transaction_id) throw new Error('出入库生成的账务请通过原单作废');
  if (entry.delivery_note_id) throw new Error('送货单生成的账务请通过原单作废');
  return atomicMutation(() => {
    // 作废与往来对象关联的账本流水时，同步恢复往来余额，保证余额与有效账本一致。
    if (entry.party_id != null) {
      const partyType = ledgerPartyType(entry, cache);
      const amount = roundDecimal(Number(entry.amount || 0), MONEY_DECIMALS);
      const delta = entry.type === 'settlement' ? amount : -amount;
      if (partyType === 'customer') {
        const party = getCustomer(entry.party_id);
        if (party) {
          const next = roundDecimal(Number(party.debt || 0) + delta, MONEY_DECIMALS);
          if (next < 0) throw new Error('作废该账本记录后客户应收将为负数，请先核对往来流水');
          party.debt = next; party.balance_updated_at = Date.now();
        }
      } else if (partyType === 'supplier') {
        const party = getSupplier(entry.party_id);
        if (party) {
          const next = roundDecimal(Number(party.payable || 0) + delta, MONEY_DECIMALS);
          if (next < 0) throw new Error('作废该账本记录后供应商应付将为负数，请先核对往来流水');
          party.payable = next; party.balance_updated_at = Date.now();
        }
      }
    }
    entry.voided_at = Date.now();
    persist(); return entry;
  });
}
function getLedgerAttachments(id) {
  const entry = cache.ledger.find(row => row.id === Number(id));
  if (!entry) throw Object.assign(new Error('流水不存在'), { status: 404 });
  return entry.attachments || [];
}
function addLedgerAttachment(id, upload) {
  const entry = cache.ledger.find(row => row.id === Number(id));
  if (!entry) throw Object.assign(new Error('流水不存在'), { status: 404 });
  const transaction = cache.transactions.find(row => row.id === entry.transaction_id);
  const meta = ledgerAttachments.add(entry, upload, {
    party_id: entry.party_id || null, party_type: entry.party_type || null, party_name: entry.party_name || '',
    transaction_id: entry.transaction_id || null, delivery_note_id: entry.delivery_note_id || transaction?.delivery_note_id || null,
    document_no: transaction?.outbound_no || transaction?.order_no || '', amount: entry.amount, ledger_created_at: entry.created_at
  });
  persist(); return meta;
}
function readLedgerAttachment(id, attachmentId) {
  const meta = getLedgerAttachments(id).find(item => item.id === attachmentId);
  if (!meta) throw Object.assign(new Error('凭证不存在或不属于这笔流水'), { status: 404 });
  return { data: ledgerAttachments.read(meta) };
}
function systemLedger(type, amount, partyId, partyName, transactionId, remark, partyType = null) {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const entry = { id: cache._meta.nextLedgerId++, type, amount: roundDecimal(amount, MONEY_DECIMALS), remark: String(remark || ''), party_id: partyId ? Number(partyId) : null, party_type: partyType || null, party_name: String(partyName || ''), transaction_id: transactionId ? Number(transactionId) : null, created_at: Date.now() };
  cache.ledger.push(entry); return entry;
}
function ledgerPartyType(entry, data, partyIds) {
  if (entry.party_type === 'customer' || entry.party_type === 'supplier') return entry.party_type;
  if (entry.type === 'receivable') return 'customer';
  if (entry.type === 'payable') return 'supplier';
  if (entry.type !== 'settlement' || entry.party_id == null) return null;
  const customer = partyIds ? partyIds.customers.has(Number(entry.party_id)) : (data.customers || []).some(row => Number(row.id) === Number(entry.party_id));
  const supplier = partyIds ? partyIds.suppliers.has(Number(entry.party_id)) : (data.suppliers || []).some(row => Number(row.id) === Number(entry.party_id));
  return customer === supplier ? null : customer ? 'customer' : 'supplier';
}
function accountingBalances(data) {
  const movements = new Map(), customer = new Map(), supplier = new Map();
  const partyIds = {
    customers: new Set((data.customers || []).map(row => Number(row.id))),
    suppliers: new Set((data.suppliers || []).map(row => Number(row.id)))
  };
  for (const tx of data.transactions || []) {
    if (tx.voided_at) continue;
    const id = Number(tx.product_id);
    const delta = tx.type === 'in' ? Number(tx.quantity || 0) : tx.type === 'out' ? -Number(tx.quantity || 0) : Number(tx.adjustment ?? tx.quantity ?? 0);
    movements.set(id, (movements.get(id) ?? 0) + delta);
  }
  for (const entry of data.ledger || []) {
    if (entry.voided_at) continue;
    const type = ledgerPartyType(entry, data, partyIds);
    if (!type) continue;
    const totals = type === 'customer' ? customer : supplier;
    const id = Number(entry.party_id), amount = Number(entry.amount) || 0;
    totals.set(id, (totals.get(id) ?? 0) + (entry.type === 'settlement' ? -amount : amount));
  }
  // Preserve the original per-record addition order and final rounding.
  for (const [id, amount] of movements) movements.set(id, roundDecimal(amount, 6));
  for (const totals of [customer, supplier]) for (const [id, amount] of totals) totals.set(id, roundDecimal(amount, 2));
  return { movements, customer, supplier };
}
function validateAccountingDelta(before, after) {
  const beforeBalances = accountingBalances(before), afterBalances = accountingBalances(after);
  const beforeProducts = new Map((before.products || []).map(row => [Number(row.id), row]));
  for (const product of after.products || []) {
    const previous = beforeProducts.get(Number(product.id));
    if (!previous) continue; // Initial stock has no transaction baseline.
    const stockDelta = roundDecimal(Number(product.stock || 0) - Number(previous.stock || 0), 6);
    const movementDelta = roundDecimal((afterBalances.movements.get(Number(product.id)) || 0) - (beforeBalances.movements.get(Number(product.id)) || 0), 6);
    if (Math.abs(stockDelta - movementDelta) > 1e-6) throw new Error(`库存与出入库流水不一致：商品 ${product.id}`);
  }
  const checkParty = (partyType, balanceField, rows) => {
    const previousRows = new Map((before[rows] || []).map(row => [Number(row.id), row]));
    for (const party of after[rows] || []) {
      const previous = previousRows.get(Number(party.id));
      if (!previous) continue; // Opening balance is created together with its ledger entry.
      const balanceDelta = roundDecimal(Number(party[balanceField] || 0) - Number(previous[balanceField] || 0), 2);
      const ledgerDelta = roundDecimal((afterBalances[partyType].get(Number(party.id)) || 0) - (beforeBalances[partyType].get(Number(party.id)) || 0), 2);
      if (Math.abs(balanceDelta - ledgerDelta) > 0.005) throw new Error(`往来余额与账本不一致：${partyType} ${party.id}`);
    }
  };
  checkParty('customer', 'debt', 'customers');
  checkParty('supplier', 'payable', 'suppliers');
  const beforeTransactions = new Map((before.transactions || []).map(row => [Number(row.id), row]));
  const linkedLedger = new Map();
  for (const entry of after.ledger || []) {
    const id = Number(entry.transaction_id);
    const entries = linkedLedger.get(id);
    if (entries) entries.push(entry); else linkedLedger.set(id, [entry]);
  }
  const stocktakes = new Map((after.stocktakes || []).map(row => [Number(row.id), row]));
  for (const tx of after.transactions || []) {
    const previous = beforeTransactions.get(Number(tx.id));
    // Existing stocktake adjustments must remain ledger-consistent on every
    // transaction, even when the adjustment row itself did not change (for
    // example, when a caller tries to attach an extra ledger entry later).
    if (previous && previous.voided_at === tx.voided_at && previous.amount === tx.amount && tx.type !== 'adjustment') continue;
    const linked = linkedLedger.get(Number(tx.id)) || [];
    const active = linked.filter(entry => !entry.voided_at);
      if (tx.type === 'adjustment') {
      const take = stocktakes.get(Number(tx.stocktake_id));
      if (take && (Number(tx.product_id) !== Number(take.product_id)
        || roundDecimal(Number(tx.adjustment ?? 0), 6) !== roundDecimal(Number(take.diff ?? 0), 6)
        || roundDecimal(Number(tx.quantity), 6) !== roundDecimal(Math.abs(Number(take.diff ?? 0)), 6))) {
        throw new Error(`盘点流水 ${tx.id} 与盘点记录不一致`);
      }
      const expectedAdjustmentLedgerType = Number(take?.diff) > 0 ? 'income' : 'expense';
      if (!tx.voided_at && take && active.some(entry => entry.type !== expectedAdjustmentLedgerType)) {
        throw new Error(`盘点流水 ${tx.id} 收支方向不一致`);
      }
      const requiresAdjustmentLedger = Number(tx.amount || 0) > 0;
      if (tx.voided_at ? active.length !== 0 : (requiresAdjustmentLedger ? active.length !== 1 : active.length !== 0)) {
        throw new Error(`盘点流水 ${tx.id} 与账本流水不一致`);
      }
      if (!tx.voided_at && active.length === 1 && roundDecimal(Number(active[0].amount), 2) !== roundDecimal(Number(tx.amount), 2)) {
        throw new Error(`盘点流水 ${tx.id} 金额不一致`);
      }
    }
    const hasParty = tx.customer_id != null || tx.supplier_id != null;
    const zeroAmount = roundDecimal(Number(tx.amount || 0), 2) === 0;
    if (hasParty && zeroAmount) {
      // 零金额交易（赠品/免费样）保留往来对象关联但不产生应收应付账本。
      if (active.length !== 0) throw new Error(`交易与账本流水不一致：交易 ${tx.id}`);
    } else if (hasParty) {
      if (tx.voided_at ? active.length : active.length !== 1) throw new Error(`交易与账本流水不一致：交易 ${tx.id}`);
      if (!tx.voided_at && active.length === 1 && roundDecimal(Number(active[0].amount), 2) !== roundDecimal(Number(tx.amount), 2)) throw new Error(`交易与账本金额不一致：交易 ${tx.id}`);
    }
  }
}
function listOrders(f={}) {
  let l = cache.orders.filter(order => f.status === undefined || order.status === f.status).slice();
  if (f.customer_id) l = l.filter(order => Number(order.customer_id) === Number(f.customer_id));
  const from = f.from === undefined ? undefined : parseDateQuery(String(f.from));
  const to = f.to === undefined ? undefined : parseDateQuery(String(f.to), true);
  if (from !== undefined) l = l.filter(order => Number(order.created_at) >= from);
  if (to !== undefined) l = l.filter(order => Number(order.created_at) <= to);
  if (f.keyword) {
    const keyword = String(f.keyword).toLowerCase();
    l = l.filter(order => [order.order_no, order.customer_name, order.status, order.remark, order.specification, order.material]
      .some(value => String(value || '').toLowerCase().includes(keyword)));
  }
  return l.sort((a,b)=>b.created_at-a.created_at || b.id-a.id);
}
function listOrderEvents(orderId) {
  const id = Number(orderId);
  return cache.order_events.filter(event => event.order_id === id).sort((a,b) => b.created_at - a.created_at);
}
function addOrder(d){
  if(!String(d.order_no||'').trim()) throw new Error('订单号不能为空');
  const orderNo = String(d.order_no).trim();
  if (cache.orders.some(order => order.order_no === orderNo)) throw Object.assign(new Error('订单号已存在'), { status: 409 });
  const q=numberValue(d.quantity === undefined ? 1 : d.quantity, '订单数量', true), p=numberValue(d.unit_price === undefined ? 0 : d.unit_price, '订单单价');
  const status = d.status || '待生产';
  if (!ORDER_STATUSES.includes(status)) throw new Error('订单状态无效');
   const x={id:cache._meta.nextOrderId++,order_no:orderNo,customer_id:d.customer_id?Number(d.customer_id):null,customer_name:(d.customer_id && getCustomer(Number(d.customer_id))) ? String(getCustomer(Number(d.customer_id)).name) : String(d.customer_name||''),specification:String(d.specification||''),material:String(d.material||''),quantity:q,unit:String(d.unit||'件'),unit_price:p,amount:lineAmount(q,p),delivery_date:String(d.delivery_date||''),status,remark:String(d.remark||''),created_at:Date.now()};cache.orders.push(x);persist();return x;
}
function orderShippedQuantity(orderId) {
  return roundDecimal(cache.transactions.filter(tx => tx.order_id === Number(orderId) && tx.type === 'out' && !tx.voided_at).reduce((sum, tx) => sum + Number(tx.quantity || 0), 0), 6);
}
const ORDER_TRANSITIONS = { '待生产': ['生产中', '已取消'], '生产中': ['已发货', '已取消'], '已发货': ['已完成'], '已完成': [] };
function updateOrder(id,d){
  const x=cache.orders.find(o=>o.id===Number(id));
  if(!x)throw new Error('订单不存在');
  const before=x.status;
  if (d.order_no !== undefined && !String(d.order_no).trim()) throw new Error('订单号不能为空');
  if (d.order_no !== undefined) {
    const orderNo = String(d.order_no).trim();
    if (cache.orders.some(order => order.id !== x.id && order.order_no === orderNo)) throw Object.assign(new Error('订单号已存在'), { status: 409 });
    d.order_no = orderNo;
  }
  if (['已完成', '已取消'].includes(before) && (d.quantity !== undefined || d.unit_price !== undefined)) throw new Error('终态订单不能修改数量或单价，请新建订单修正');
  if (d.quantity !== undefined) d.quantity = numberValue(d.quantity, '订单数量', true);
  if (d.unit_price !== undefined) d.unit_price = numberValue(d.unit_price, '订单单价');
  const shipped = orderShippedQuantity(x.id);
  if (d.quantity !== undefined && roundDecimal(Number(d.quantity), 6) < shipped) throw new Error(`订单数量不能小于已发货数量 ${shipped}，请先作废出库或新建订单修正`);
  if (d.customer_id !== undefined && shipped > 0 && Number(d.customer_id) !== Number(x.customer_id)) throw new Error('订单已有出库记录，不能更换客户，请先作废出库后再修改');
  if (d.unit !== undefined && shipped > 0 && String(d.unit) !== String(x.unit)) throw new Error('订单已有出库记录，不能修改单位，请先作废出库后再修改');
  if (d.status !== undefined) {
    if (!ORDER_STATUSES.includes(d.status)) throw new Error('订单状态无效');
    if (d.status !== before && !(ORDER_TRANSITIONS[before] || []).includes(d.status)) throw new Error(`订单不能从「${before}」变更为「${d.status}」`);
  }
  // Record creation time is server-owned metadata; never allow a direct
  // caller to rewrite it while updating business fields.
  const { id: _ignoredId, created_at: _ignoredCreatedAt, updated_at: _ignoredUpdatedAt, ...changes } = d;
  Object.assign(x, changes);
  if(d.quantity!==undefined||d.unit_price!==undefined)x.amount=lineAmount(Number(x.quantity)||0, Number(x.unit_price)||0);
  if(d.status&&d.status!==before)cache.order_events.push({id:cache._meta.nextOrderEventId++,order_id:x.id,from:before,to:d.status,created_at:Date.now()});
  persist();return x;
}
function parseDateValue(value, fallback = Date.now()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > Date.now()) throw new Error('盘点日期不能晚于今天');
    return value;
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      if (localDate(date) > localDate()) throw new Error('盘点日期不能晚于今天');
      return date.getTime();
    }
    throw new Error('日期格式无效');
  }
  const timestamp = new Date(text).getTime();
  if (Number.isFinite(timestamp)) {
    if (timestamp > Date.now()) throw new Error('盘点日期不能晚于今天');
    return timestamp;
  }
  throw new Error('日期格式无效');
}
function addStocktake(d){
  const p=getProduct(Number(d.product_id));
  if(!p)throw new Error('商品不存在');
  const counted=roundDecimal(numberValue(d.counted_stock, '\u76d8\u70b9\u5e93\u5b58'), 6);
  return atomicMutation(() => {
    const before=roundDecimal(p.stock, 6),diff=roundDecimal(counted-before, 6),createdAt=Date.now(),countedAt=parseDateValue(d.counted_at, createdAt);
    p.stock=counted;p.updated_at=createdAt;p.stock_updated_at=createdAt;
    const x={id:cache._meta.nextStocktakeId++,product_id:p.id,product_name:p.name,before_stock:before,counted_stock:counted,diff,remark:String(d.remark||''),counted_at:countedAt,created_at:createdAt};
    cache.stocktakes.push(x);
    const adjustmentAmount = lineAmount(Math.abs(diff), numberValue(p.price, '成本价'));
    const transaction = { id:cache._meta.nextTransactionId++, product_id:p.id, product_name:p.name, type:'adjustment', quantity:roundDecimal(Math.abs(diff), 6), operator:String(d.operator||''), remark:x.remark||'库存盘点', created_at:createdAt, specification:p.specification||'', material:p.material||'', unit:p.unit||'件', unit_price:Number(p.price)||0, amount:adjustmentAmount, adjustment:diff, stocktake_id: x.id };
    cache.transactions.push(transaction);
    systemLedger(diff >= 0 ? 'income' : 'expense', adjustmentAmount, null, '', transaction.id, `${diff >= 0 ? '盘盈' : '盘亏'}调整 · ${p.name}`);
    return {product:p,stocktake:x};
  });
}
function listStocktakes(f={}){let l=cache.stocktakes.slice();if(f.product_id)l=l.filter(x=>x.product_id===Number(f.product_id));return l.sort((a,b)=>b.created_at-a.created_at || b.id-a.id);}
function listDeliveryNotes(){return cache.delivery_notes.slice().sort((a,b)=>b.created_at-a.created_at || b.id-a.id);}
function getDeliveryNote(id){return cache.delivery_notes.find(note=>note.id===Number(id))||null;}
function addDeliveryNote(data) {
  if (!Array.isArray(data.lines) || !data.lines.length) throw new Error('至少添加一行商品');
  const workOrderNo = String(data.work_order_no || '').trim();
  if (workOrderNo && cache.delivery_notes.some(note => !note.voided_at && String(note.work_order_no || '').trim() === workOrderNo) && data.confirm_duplicate_work_order !== true) {
    throw new Error(`工单编号「${workOrderNo}」已有未作废送货单，请确认后再重复开单`);
  }
  const now = Date.now(); const supplier = activeParty(data.supplier_id, 'supplier');
  const freight = numberValue(data.freight === undefined ? 0 : data.freight, '运费');
  const date = data.date === undefined ? localDate() : String(data.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('日期格式无效');
  if (date > localDate()) throw new Error('业务日期不能晚于今天');
  const seen = new Set();
  const prepared = data.lines.map(raw => {
    const product = getProduct(Number(raw?.product_id));
    if (!product || product.deleted_at) throw new Error('请选择有效商品，入库不会自动创建商品');
    if (seen.has(product.id)) throw new Error('同一商品不能重复入库，请合并数量');
    seen.add(product.id);
    const quantity = numberValue(raw.quantity, '计划数量', true);
    const delivered = numberValue(raw.delivered_qty === undefined ? quantity : raw.delivered_qty, '实际入库数量');
    const values = stockValues(product, delivered, raw, delivered > 0);
    const specification = String(raw.specification ?? product.specification ?? '').trim();
    const [length, width] = dimensions(specification, product);
    const square = roundDecimal(delivered * length * width / 1000000, 4);
    if (!Number.isFinite(square)) throw new Error('面积超出支持范围');
    return { product, quantity, delivered, ...values, specification, length, width, square };
  });
  return atomicMutation(() => {
    const note = { id: cache._meta.nextDeliveryNoteId++, date, work_order_no: workOrderNo, supplier_id: supplier?.id || null, supplier_name: supplier?.name || '', driver_phone: String(data.driver_phone || '').trim(), vehicle_no: String(data.vehicle_no || '').trim(), operator: String(data.operator || '').trim(), freight, remark: String(data.remark || '').trim(), lines: [], total_square_meters: 0, total_amount: 0, created_at: now };
    for (const item of prepared) {
      const { product, quantity, delivered, unit, unitPrice, amount, specification, length, width, square } = item;
      const result = delivered > 0 ? stockIn(product.id, delivered, note.operator, note.remark || `送货单 ${note.work_order_no}`, note.supplier_id, { specification, unit, unit_price: unitPrice, delivery_note_id: note.id, work_order_no: note.work_order_no, delivered_qty: delivered, square_meters: square }) : null;
      note.lines.push({ product_id: product.id, product_name: product.name, specification, unit, length, width, quantity, unit_price: unitPrice, delivered_qty: delivered, square_meters: square, amount, ...(result ? { transaction_id: result.transaction.id } : {}) });
      note.total_square_meters += square; note.total_amount += amount;
    }
    note.total_square_meters = roundDecimal(note.total_square_meters, 4);
    note.total_amount = roundDecimal(note.total_amount, 2);
    // Freight is recorded separately as an expense; it does not increase supplier goods payable.
    if (freight > 0) {
      const expense = systemLedger('expense', freight, null, note.driver_phone || note.vehicle_no || '', null, `入库运费 · ${note.work_order_no || `送货单 #${note.id}`}`);
      if (expense) expense.delivery_note_id = note.id;
    }
    cache.delivery_notes.push(note); persist(); return note;
  });
}
cleanupResidualTemps();
createAutoBackup('startup');
let batching = false;
let cache = load();
if (migratedDimensions) persist();
function atomicMutation(action) {
  if (batching) return action();
  const before = JSON.stringify(cache);
  batching = true;
  try { const result = action(); validateNonNegativeState(cache); validateAccountingDelta(JSON.parse(before), cache); batching = false; persist(); return result; }
  catch (error) { cache = JSON.parse(before); throw error; }
  finally { batching = false; }
}
function validateNonNegativeState(data) {
  const check = (rows, field, label) => (rows || []).forEach(row => {
    if (row[field] === undefined || row[field] === null) return;
    const value = Number(row[field]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label}无效`);
  });
  check(data.products, 'stock', '商品库存');
  check(data.products, 'price', '商品单价');
  check(data.customers, 'debt', '客户应收');
  check(data.suppliers, 'payable', '供应商应付');
  check(data.transactions, 'quantity', '流水数量');
  check(data.transactions, 'unit_price', '流水单价');
  check(data.transactions, 'amount', '流水金额');
  check(data.ledger, 'amount', '账本金额');
  check(data.orders, 'quantity', '订单数量');
  check(data.orders, 'unit_price', '订单单价');
  check(data.orders, 'amount', '订单金额');
  check(data.stocktakes, 'before_stock', '盘点前库存');
  check(data.stocktakes, 'counted_stock', '盘点库存');
  check(data.delivery_notes, 'freight', '送货运费');
  check(data.delivery_notes, 'total_amount', '送货单金额');
  check(data.delivery_notes, 'total_square_meters', '送货单面积');
  (data.delivery_notes || []).forEach(note => (note.lines || []).forEach(line => {
    for (const [field, label] of [['quantity', '送货计划数量'], ['delivered_qty', '送货实收数量'], ['unit_price', '送货单价'], ['amount', '送货金额'], ['square_meters', '送货面积']]) {
      if (line[field] === undefined || line[field] === null) continue;
      const value = Number(line[field]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${label}无效`);
    }
  }));
}
function normalizeGhostStock(data, source) {
  const products = Array.isArray(data?.products) ? data.products : [];
  const ghostStockProducts = products.filter(product => Number.isFinite(Number(product.stock)) && Number(product.stock) !== 0 && Math.abs(Number(product.stock)) < 1e-6);
  if (!ghostStockProducts.length) return 0;
  const now = Date.now();
  ghostStockProducts.forEach(product => { product.stock = 0; product.updated_at = now; product.stock_updated_at = now; });
  console.warn(`[db] ${source} normalized ghost stock: ${ghostStockProducts.length}`);
  return ghostStockProducts.length;
}
const ghostStockProducts = cache.products.filter(product => Number.isFinite(Number(product.stock)) && Number(product.stock) !== 0 && Math.abs(Number(product.stock)) < 1e-6);
if (ghostStockProducts.length) {
  normalizeGhostStock(cache, 'startup');
  persist();
}
function persist() {
  if (batching) return;
  const tmp = `${DB_PATH}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(cache, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, DB_PATH);
    syncDirectory(path.dirname(DB_PATH));
  } catch (error) {
    // Persistence failures are server errors, not user-correctable validation.
    throw Object.assign(error, { status: 500 });
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    catch (error) { console.warn('[db] temporary file cleanup failed:', error.message); }
  }
}

function revision() { return cache._collaboration?.revision || 0; }
function audit() { return cache._collaboration?.audit || []; }
function generation() { return Number(cache._collaboration?.generation) || 0; }
function receipt(actorId, key) {
  const state = cache._collaboration || { receipts: {} };
  const item = state.receipts?.[`${actorId}:${key}`];
  if (!item) return null;
  const itemGeneration = Number.isInteger(item.generation) ? item.generation : 0;
  if (itemGeneration !== (Number(state.generation) || 0) || item.time < Date.now() - 7 * 86400000) return null;
  return JSON.parse(JSON.stringify(item));
}
// The service has one Node process; synchronous mutations and one atomic file replacement
// commit the stock, balances, audit entry and idempotency receipt together.
function transact(actor, key, fingerprint, expected, operation, action, options = {}) {
  const previous = JSON.stringify(cache);
  const state = cache._collaboration || { revision: 0, audit: [], receipts: {}, generation: 0 };
  if (!Number.isInteger(state.generation)) state.generation = 0;
  const receiptKey = `${actor.id}:${key}`;
  const storedReceipt = state.receipts[receiptKey];
  if (storedReceipt) {
    const storedGeneration = Number.isInteger(storedReceipt.generation) ? storedReceipt.generation : 0;
    if (storedGeneration !== state.generation) throw Object.assign(new Error('提交编号对应的数据已被恢复覆盖，请刷新后重新核对'), { status: 409 });
    if (storedReceipt.fingerprint !== fingerprint) throw Object.assign(new Error('重复请求编号对应不同内容'), { status: 409 });
    return { data: storedReceipt.data, revision: revision(), replayed: true };
  }
  if (expected !== String(revision())) throw Object.assign(new Error('数据已被其他人更新，请刷新后重新提交'), { status: 409 });
  batching = true;
  try {
    cache._collaboration = state;
    const data = action();
    for (const [collection, field] of [['products','stock'], ['products','price'], ['customers','debt'], ['suppliers','payable'], ['orders','quantity'], ['orders','amount']]) {
      if (cache[collection].some(row => row[field] !== undefined && (!Number.isFinite(row[field]) || row[field] < 0))) throw new Error('数量、库存或金额无效');
    }
    validateNonNegativeState(cache);
    if (!options.skipAccountingDelta) validateAccountingDelta(JSON.parse(previous), cache);
    state.revision++;
    state.audit.push({ id: state.revision, actor_id: actor.id, actor_name: actor.username, operation, time: Date.now(), record_id: data?.id || data?.transaction?.id || null });
    state.receipts[receiptKey] = { fingerprint, data: JSON.parse(JSON.stringify(data)), time: Date.now(), generation: state.generation };
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
  l.sort((a,b) => (b.profile_updated_at||b.updated_at||0)-(a.profile_updated_at||a.updated_at||0) || b.id-a.id);
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
    stock: roundDecimal(numeric(d.stock, '\u521d\u59cb\u5e93\u5b58'), 6),
    safety_stock: numeric(d.safety_stock, '安全库存'),
    supplier_id: null,
    supplier_name: '',
    created_at: now, updated_at: now, profile_updated_at: now, stock_updated_at: now
  };
  if (d.supplier_id) { const s = getSupplier(Number(d.supplier_id)); if (s) { p.supplier_id = s.id; p.supplier_name = s.name; } }
  cache.products.push(p); persist(); return p;
}
function updateProduct(id, d) {
  const p = getProduct(id); if (!p) throw new Error('商品不存在');
  const beforeProfile = JSON.stringify({ name: p.name, category: p.category, specification: p.specification, material: p.material, corrugation: p.corrugation, weight: p.weight, length: p.length, width: p.width, layers: p.layers, unit: p.unit, price: p.price, safety_stock: p.safety_stock, supplier_id: p.supplier_id, image_url: p.image_url });
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
  const now = Date.now(); p.updated_at = now;
  const afterProfile = JSON.stringify({ name: p.name, category: p.category, specification: p.specification, material: p.material, corrugation: p.corrugation, weight: p.weight, length: p.length, width: p.width, layers: p.layers, unit: p.unit, price: p.price, safety_stock: p.safety_stock, supplier_id: p.supplier_id, image_url: p.image_url });
  if (beforeProfile !== afterProfile) p.profile_updated_at = now;
  persist(); return p;
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
  l.sort((a,b) => (b.profile_updated_at||b.updated_at||0)-(a.profile_updated_at||a.updated_at||0) || b.id-a.id);
  return l;
}
function getCustomer(id) { return cache.customers.find(c => c.id===id) || null; }
function addCustomer(d) {
  if (!d.name || !String(d.name).trim()) throw new Error('客户名称不能为空');
  const debt = d.debt === undefined ? 0 : moneyValue(d.debt, '期初应收');
  const now = Date.now();
  const c = {
    id: cache._meta.nextCustomerId++,
    name: String(d.name).trim(),
    contact: d.contact || '',
    phone: d.phone || '',
    address: d.address || '',
    remark: d.remark || '',
    debt,
    created_at: now, updated_at: now, profile_updated_at: now, balance_updated_at: debt > 0 ? now : 0
  };
  cache.customers.push(c);
  if (debt > 0) systemLedger('receivable', debt, c.id, c.name, null, `客户期初应收 · ${c.name}`, 'customer');
  persist(); return c;
}
function updateCustomer(id, d) {
  if (d.specs !== undefined) {
    if (!Array.isArray(d.specs) || d.specs.length > 500 || d.specs.some(s => !s || typeof s.id !== 'string' || !String(s.goods || '').trim() || !String(s.specification || '').trim() || !Number.isFinite(s.price) || s.price < 0)) throw new Error('客户规格资料无效');
    if (new Set(d.specs.map(s => s.id)).size !== d.specs.length) throw new Error('客户规格编号重复');
  }
  const c = getCustomer(id); if (!c) throw new Error('客户不存在');
  if (d.specs !== undefined) c.specs = d.specs.map(s => ({ id: s.id, goods: String(s.goods).trim(), specification: String(s.specification).trim(), material: String(s.material || ''), unit: String(s.unit || '个'), price: s.price }));
  const beforeProfile = JSON.stringify({ name: c.name, contact: c.contact, phone: c.phone, address: c.address, remark: c.remark });
  if (d.name!==undefined) { if (!String(d.name).trim()) throw new Error('名称不能为空'); c.name = String(d.name).trim(); }
  if (d.contact!==undefined) c.contact = d.contact;
  if (d.phone!==undefined) c.phone = d.phone;
  if (d.address!==undefined) c.address = d.address;
  if (d.remark!==undefined) c.remark = d.remark;
  if (d.debt!==undefined) {
    const before = moneyValue(c.debt, '应收余额');
    c.debt = moneyValue(d.debt, '应收余额');
    const settlementRemark = String(d.settlement_remark || '').trim();
    if (c.debt < before) systemLedger('settlement', moneyValue(before - c.debt, '结算金额', true), c.id, c.name, null, settlementRemark || `客户欠款结清 · ${c.name}`, 'customer');
    else if (c.debt > before) systemLedger('receivable', moneyValue(c.debt - before, '应收增量', true), c.id, c.name, null, settlementRemark || `客户补录应收 · ${c.name}`, 'customer');
  }
  const now = Date.now(); c.updated_at = now;
  const afterProfile = JSON.stringify({ name: c.name, contact: c.contact, phone: c.phone, address: c.address, remark: c.remark });
  if (beforeProfile !== afterProfile) c.profile_updated_at = now;
  if (d.debt !== undefined) c.balance_updated_at = now;
  persist(); return c;
}
function deleteCustomer(id) {
  const i = cache.customers.findIndex(c => c.id===id);
  if (i===-1) throw new Error('客户不存在');
  if (roundDecimal(Number(cache.customers[i].debt || 0), MONEY_DECIMALS) !== 0) throw new Error('客户仍有未结清应收，请先结清后再停用');
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
  l.sort((a,b) => (b.profile_updated_at||b.updated_at||0)-(a.profile_updated_at||a.updated_at||0) || b.id-a.id);
  return l;
}
function getSupplier(id) { return cache.suppliers.find(s => s.id===id) || null; }
function addSupplier(d) {
  if (!d.name || !String(d.name).trim()) throw new Error('供应商名称不能为空');
  const payable = d.payable === undefined ? 0 : moneyValue(d.payable, '期初应付');
  const now = Date.now();
  const s = { id: cache._meta.nextSupplierId++, name: String(d.name).trim(), contact:d.contact||'', phone:d.phone||'', address:d.address||'', remark:d.remark||'', payable, created_at:now, updated_at:now, profile_updated_at:now, balance_updated_at: payable > 0 ? now : 0 };
  cache.suppliers.push(s);
  if (payable > 0) systemLedger('payable', payable, s.id, s.name, null, `供应商期初应付 · ${s.name}`, 'supplier');
  persist(); return s;
}
function updateSupplier(id,d) {
  const s = getSupplier(id); if (!s) throw new Error('供应商不存在');
  const beforeProfile = JSON.stringify({ name: s.name, contact: s.contact, phone: s.phone, address: s.address, remark: s.remark });
  if (d.name!==undefined) { if (!String(d.name).trim()) throw new Error('名称不能为空'); s.name=String(d.name).trim(); }
  if (d.contact!==undefined) s.contact=d.contact; if (d.phone!==undefined) s.phone=d.phone; if (d.address!==undefined) s.address=d.address; if (d.remark!==undefined) s.remark=d.remark;
  if (d.payable!==undefined) {
    const before = moneyValue(s.payable, '应付余额');
    s.payable = moneyValue(d.payable, '应付余额');
    const settlementRemark = String(d.settlement_remark || '').trim();
    if (s.payable < before) systemLedger('settlement', moneyValue(before - s.payable, '结算金额', true), s.id, s.name, null, settlementRemark || `供应商应付款结清 · ${s.name}`, 'supplier');
    else if (s.payable > before) systemLedger('payable', moneyValue(s.payable - before, '应付增量', true), s.id, s.name, null, settlementRemark || `供应商补录应付 · ${s.name}`, 'supplier');
  }
  cache.products.forEach(p => { if (p.supplier_id===id) p.supplier_name=s.name; });
  // Posted transactions retain the supplier name captured at receipt time.
  const now = Date.now(); s.updated_at=now;
  const afterProfile = JSON.stringify({ name: s.name, contact: s.contact, phone: s.phone, address: s.address, remark: s.remark });
  if (beforeProfile !== afterProfile) s.profile_updated_at = now;
  if (d.payable !== undefined) s.balance_updated_at = now;
  persist(); return s;
}
function deleteSupplier(id) {
  const i=cache.suppliers.findIndex(s=>s.id===id); if(i===-1) throw new Error('供应商不存在');
  if (roundDecimal(Number(cache.suppliers[i].payable || 0), MONEY_DECIMALS) !== 0) throw new Error('供应商仍有未结清应付，请先结清后再停用');
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
function stockValues(product, quantity, details, positive = true) {
  const qty = numberValue(quantity, '数量', positive);
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
    // Timestamps are authoritative server metadata.  The former recorded_at
    // escape hatch allowed clients to forge ordering and "today" statistics.
    const createdAt = Date.now();
    product.stock = after; product.updated_at = createdAt; product.stock_updated_at = createdAt;
    const tx = { id: cache._meta.nextTransactionId++, product_id: product.id, product_name: product.name, type, quantity: qty, operator: String(op || ''), remark: String(remark || ''), created_at: createdAt, specification: details.specification ?? product.specification ?? '', material: details.material ?? product.material ?? '', unit, unit_price: unitPrice, amount };
    tx[incoming ? 'supplier_id' : 'customer_id'] = party?.id || null;
    tx[incoming ? 'supplier_name' : 'customer_name'] = party?.name || '';
    for (const field of ['corrugation', 'weight', 'length', 'width', 'layers']) tx[field] = product[field];
    for (const field of ['delivery_note_id', 'work_order_no', 'delivered_qty', 'square_meters']) if (details[field] !== undefined) tx[field] = details[field];
    if (party) {
      const balance = incoming ? 'payable' : 'debt';
      party[balance] = roundDecimal(Number(party[balance] || 0) + amount, 2);
      systemLedger(incoming ? 'payable' : 'receivable', amount, party.id, party.name, tx.id, `${label}${incoming ? '应付款' : '应收款'} · ${product.name}`, incoming ? 'supplier' : 'customer');
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
  const from = f.from === undefined ? undefined : parseDateQuery(String(f.from));
  const to = f.to === undefined ? undefined : parseDateQuery(String(f.to), true);
  if (from !== undefined) l = l.filter(t => t.created_at >= from);
  if (to !== undefined) l = l.filter(t => t.created_at <= to);
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
  l.sort((a,b) => b.created_at-a.created_at || b.id-a.id);
  const customerNames = new Map(cache.customers.map(party => [party.id, party.name]));
  const supplierNames = new Map(cache.suppliers.map(party => [party.id, party.name]));
  return l.map(t => ({
    ...t,
    product_name: t.product_name ?? getProduct(t.product_id)?.name ?? '',
    customer_current_name: customerNames.get(t.customer_id) ?? '',
    supplier_current_name: supplierNames.get(t.supplier_id) ?? ''
  }));
}
function streamTx(f = {}) {
  const includeVoided = f.include_voided === 'true';
  const from = f.from === undefined ? undefined : parseDateQuery(String(f.from));
  const to = f.to === undefined ? undefined : parseDateQuery(String(f.to), true);
  const keyword = f.keyword ? String(f.keyword).toLowerCase() : '';
  const matches = tx => {
    if (!includeVoided && tx.voided_at) return false;
    if (f.type && tx.type !== f.type) return false;
    if (f.product_id && tx.product_id !== Number(f.product_id)) return false;
    if (f.customer_id && tx.customer_id !== Number(f.customer_id)) return false;
    if (f.supplier_id && tx.supplier_id !== Number(f.supplier_id)) return false;
    if (from !== undefined && tx.created_at < from) return false;
    if (to !== undefined && tx.created_at > to) return false;
    if (keyword) { const product = getProduct(tx.product_id); if (!((product && product.name.toLowerCase().includes(keyword)) || (tx.remark && tx.remark.toLowerCase().includes(keyword)) || (tx.customer_name && tx.customer_name.toLowerCase().includes(keyword)) || (tx.supplier_name && tx.supplier_name.toLowerCase().includes(keyword)))) return false; }
    return true;
  };
  const customerNames = new Map(cache.customers.map(party => [party.id, party.name]));
  const supplierNames = new Map(cache.suppliers.map(party => [party.id, party.name]));
  const decorate = tx => ({ ...tx, product_name: tx.product_name ?? getProduct(tx.product_id)?.name ?? '', customer_current_name: customerNames.get(tx.customer_id) ?? '', supplier_current_name: supplierNames.get(tx.supplier_id) ?? '' });
  let count = 0;
  for (let index = cache.transactions.length - 1; index >= 0; index -= 1) if (matches(cache.transactions[index])) count += 1;
  function* rows() { for (let index = cache.transactions.length - 1; index >= 0; index -= 1) { const tx = cache.transactions[index]; if (matches(tx)) yield decorate(tx); } }
  return { count, rows: rows() };
}

function streamLedger(f = {}) {
  const includeVoided = f.include_voided === 'true';
  const from = f.from === undefined ? undefined : parseDateQuery(String(f.from));
  const to = f.to === undefined ? undefined : parseDateQuery(String(f.to), true);
  const keyword = f.keyword ? String(f.keyword).toLowerCase() : '';
  const matches = entry => (!includeVoided && entry.voided_at) ? false : f.type && entry.type !== f.type ? false : from !== undefined && entry.created_at < from ? false : to !== undefined && entry.created_at > to ? false : keyword && !(`${entry.remark || ''} ${entry.party_name || ''}`.toLowerCase().includes(keyword)) ? false : true;
  const customers = new Map(cache.customers.map(party => [Number(party.id), String(party.name || '')]));
  const suppliers = new Map(cache.suppliers.map(party => [Number(party.id), String(party.name || '')]));
  const decorate = entry => ({ ...entry, party_current_name: entry.party_id == null ? '' : (ledgerPartyType(entry, { customers: cache.customers, suppliers: cache.suppliers }) === 'supplier' ? suppliers.get(Number(entry.party_id)) || '' : customers.get(Number(entry.party_id)) || '') });
  let count = 0;
  for (let index = cache.ledger.length - 1; index >= 0; index -= 1) if (matches(cache.ledger[index])) count += 1;
  function* rows() { for (let index = cache.ledger.length - 1; index >= 0; index -= 1) { const entry = cache.ledger[index]; if (matches(entry)) yield decorate(entry); } }
  return { count, rows: rows() };
}

function reverseTransaction(tx) {
  if (tx.voided_at) throw new Error('记录已作废，不能重复作废');
  const p = getProduct(tx.product_id);
  if (!p) throw new Error('原商品不存在，无法安全恢复库存');
  if (tx.type === 'adjustment') throw new Error('盘点调整记录不能直接作废，请返回库存页打开盘点弹窗重新盘点修正');
  if (tx.type === 'in' && roundDecimal(p.stock, 6) < tx.quantity) {
    const blockers = cache.transactions
      .filter(item => !item.voided_at && item.type === 'out' && item.product_id === tx.product_id && item.created_at >= tx.created_at)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, 5)
      .map(item => `#${item.id} ${item.quantity}${item.unit || p.unit}`)
      .join('、');
    throw new Error(`无法作废：当前库存已低于该入库数量，后续出库占用${blockers ? `：${blockers}` : '，请先核对相关流水'}`);
  }
  const party = tx.type === 'in' ? getSupplier(tx.supplier_id) : getCustomer(tx.customer_id);
  if (party) {
    const field = tx.type === 'in' ? 'payable' : 'debt';
    const partyType = tx.type === 'in' ? 'supplier' : 'customer';
    const settlements = cache.ledger.filter(entry => !entry.voided_at && entry.type === 'settlement' && entry.party_id === party.id && (entry.party_type || partyType) === partyType && entry.created_at >= tx.created_at);
    if (roundDecimal(Number(party[field] || 0), 2) < Number(tx.amount || 0)) {
      const settledAmount = roundDecimal(settlements.reduce((sum, entry) => sum + Number(entry.amount || 0), 0), 2);
      const settlementIds = settlements.map(entry => `#${entry.id}`).join('、');
      throw new Error(`该往来款已部分结算 ${settledAmount} 元${settlementIds ? `，结算流水：${settlementIds}` : ''}，请先撤销结算记录后再作废`);
    }
    party[field] = roundDecimal(Number(party[field] || 0) - Number(tx.amount || 0), 2);
  }
  p.stock = roundDecimal(p.stock + (tx.type === 'in' ? -tx.quantity : tx.quantity), 6); p.updated_at = Date.now(); p.stock_updated_at = p.updated_at;
  tx.voided_at = Date.now();
  cache.ledger.forEach(entry => { if (entry.transaction_id === tx.id) entry.voided_at = tx.voided_at; });
  return { id: tx.id, product_id: tx.product_id, type: tx.type, quantity: tx.quantity, voided_at: tx.voided_at };
}
function deleteTransaction(id) {
  const tx = cache.transactions.find(t => t.id === Number(id));
  if (!tx) throw new Error('交易记录不存在');
  if (tx.delivery_note_id) throw new Error('送货单明细请从入库页面整单作废，不能单独删除');
  return atomicMutation(() => { const result = reverseTransaction(tx); const order = cache.orders.find(item => item.id === tx.order_id); if (order && (order.status === '已发货' || order.status === '已完成')) { const remaining = orderShippedQuantity(order.id); const next = remaining >= roundDecimal(Number(order.quantity || 0), 6) ? '已发货' : '生产中'; if (order.status !== next) { const before = order.status; order.status = next; cache.order_events.push({ id: cache._meta.nextOrderEventId++, order_id: order.id, from: before, to: order.status, created_at: Date.now() }); } } persist(); return result; });
}
function voidDeliveryNote(id) {
  const note = getDeliveryNote(id);
  if (!note || note.voided_at) throw new Error('送货单不存在或已作废');
  return atomicMutation(() => {
    const transactionIds = new Set(note.lines.filter(line => line.transaction_id).map(line => Number(line.transaction_id)));
    const linkedLedgers = cache.ledger.filter(entry => entry.delivery_note_id === note.id || transactionIds.has(Number(entry.transaction_id)));
    if (linkedLedgers.some(entry => entry.voided_at)) throw new Error('送货单关联账本流水已被单独作废，请先核对账本后再作废送货单');
    for (const line of note.lines) {
      if (!line.transaction_id) continue;
      const tx = cache.transactions.find(item => item.id === line.transaction_id);
      if (!tx) throw new Error('送货单流水缺失，请核对历史数据');
      reverseTransaction(tx);
    }
    note.voided_at = Date.now();
    cache.ledger.forEach(entry => { if (entry.delivery_note_id === note.id && !entry.voided_at) entry.voided_at = note.voided_at; });
    persist(); return note;
  });
}
function stats() {
  const activeProducts = cache.products.filter(p => !p.deleted_at), activeCustomers = cache.customers.filter(c => !c.deleted_at), activeSuppliers = cache.suppliers.filter(s => !s.deleted_at);
  const totalProducts = activeProducts.length;
  const totalCustomers = activeCustomers.length;
  const totalSuppliers = activeSuppliers.length;
  const totalReceivable = roundDecimal(cache.customers.reduce((sum, customer) => sum + Number(customer.debt || 0), 0), 2);
  const totalPayable = roundDecimal(cache.suppliers.reduce((sum, supplier) => sum + Number(supplier.payable || 0), 0), 2);
  const totalStock = roundDecimal(activeProducts.reduce((s,p)=>s+Number(p.stock || 0),0), 6);
  const totalStockByUnit = {};
  activeProducts.forEach(p => { const unit = String(p.unit || '件'); totalStockByUnit[unit] = roundDecimal((totalStockByUnit[unit] || 0) + Number(p.stock || 0), 6); });
  const totalValue = roundDecimal(activeProducts.reduce((sum, product) => sum + lineAmount(product.stock, product.price), 0), 2);
  // A zero safety stock means "warn only when out of stock".  Keep positive
  // inventory with no configured threshold out of the warning count while
  // still surfacing an exact zero as a stockout.
  const lowStock = activeProducts.filter(p => {
    const safety = Number(p.safety_stock) || 0;
    return Number(p.stock || 0) <= (safety > 0 ? safety : 0);
  }).length;
  const today = new Date(); today.setHours(0,0,0,0); const ts = today.getTime();
  const todayDate = localDate(today);
  const deliveryDates = new Map(cache.delivery_notes.map(note => [Number(note.id), String(note.date || '')]));
  const stocktakeDates = new Map(cache.stocktakes.map(take => [Number(take.id), localDate(new Date(Number(take.counted_at)))]));
  const todays = cache.transactions.filter(t => {
    if (t.voided_at) return false;
    if (t.delivery_note_id != null && deliveryDates.has(Number(t.delivery_note_id))) return deliveryDates.get(Number(t.delivery_note_id)) === todayDate;
    if (t.stocktake_id != null && stocktakeDates.has(Number(t.stocktake_id))) return stocktakeDates.get(Number(t.stocktake_id)) === todayDate;
    return Number(t.created_at) >= ts;
  });
  return { totalProducts, totalCustomers, totalSuppliers, totalReceivable, totalPayable, totalStock, totalStockByUnit, totalValue, lowStock,
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

function orderToOutbound(orderId, lines, op='', rmk='') {
  const order = cache.orders.find(item => item.id === Number(orderId));
  if (!order) throw new Error('订单不存在');
  if (order.status !== '生产中') throw new Error('仅生产中的订单可以出库');
  if (!Array.isArray(lines) || !lines.length) throw new Error('至少添加一项出库商品');
  const shipped = cache.transactions.filter(tx => tx.order_id === order.id && tx.type === 'out' && !tx.voided_at).reduce((sum, tx) => sum + tx.quantity, 0);
  const quantity = roundDecimal(lines.reduce((sum, line) => sum + numberValue(line.quantity, '出库数量', true), 0), 6);
  if (quantity > roundDecimal(order.quantity - shipped, 6)) throw new Error('出库数量超过订单剩余待发数量');
  for (const line of lines) {
    const product = getProduct(Number(line.product_id));
    if (product && product.unit !== order.unit) throw new Error('商品单位与订单单位不一致');
  }
  return atomicMutation(() => {
    const result = stockOutBatch(lines, op, rmk || ('订单出库 ' + order.order_no), order.customer_id || null);
    const noteNo = 'CK' + String(result[0].transaction.id).padStart(8, '0');
    for (const item of result) Object.assign(item.transaction, { order_id: order.id, order_no: order.order_no, outbound_no: noteNo });
    if (roundDecimal(shipped + quantity, 6) === roundDecimal(order.quantity, 6)) updateOrder(order.id, { status: '已发货' });
    persist();
    return { order, transactions: result };
  });
}

function portableImageUrl(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/(?:^|[\\/])uploads[\\/]products[\\/]([A-Za-z0-9._-]+)$/i);
  return match ? `/uploads/products/${match[1]}` : (raw.startsWith('/uploads/products/') && /^[A-Za-z0-9._/-]+$/.test(raw) ? raw : '');
}
function backupData(options = {}) {
  const snapshot = JSON.parse(JSON.stringify(cache));
  snapshot.products = (snapshot.products || []).map(product => ({ ...product, image_url: portableImageUrl(product.image_url) }));
  return options.includeAttachments ? ledgerAttachments.portable(snapshot, options.maxBytes) : snapshot;
}
function health() {
  let readable = false; let writable = false;
  try { fs.accessSync(DB_PATH, fs.constants.R_OK); readable = true; } catch {}
  try { fs.accessSync(DB_PATH, fs.constants.W_OK); writable = true; } catch {}
  return { online: readable && writable, dataReadable: readable, dataWritable: writable, revision: revision(), warningCount: loadWarnings.length };
}
function validateBackupData(data) {
  require('./print-notes').validateBackup(data || {});
  if (data?.customer_dimensions !== undefined) customerDimensions.validateDocument(data.customer_dimensions);
  require('./boards').validate(data || {});
  const collections = ['products', 'customers', 'suppliers', 'transactions', 'ledger', 'orders', 'order_events', 'stocktakes', 'delivery_notes'];
  if (!data || Number(data?._meta?.schemaVersion) > SCHEMA_VERSION) throw new Error('backup requires a newer schema version');
  if (!data || collections.some(name => !Array.isArray(data[name]))) throw new Error('备份文件缺少必要数据表');
  const ids = name => {
    const seen = new Set();
    for (const row of data[name]) {
      const id = Number(row?.id);
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) throw new Error(`${name} 存在重复或无效编号`);
      seen.add(id);
    }
    return seen;
  };
  const productIds = ids('products'); const customerIds = ids('customers'); const supplierIds = ids('suppliers');
  const transactionIds = ids('transactions'); ids('ledger'); const orderIds = ids('orders');
  ids('order_events'); const stocktakeIds = ids('stocktakes'); const deliveryNoteIds = ids('delivery_notes');
  const nonNegative = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label}必须是有效非负数`);
  };
  const moneyNonNegative = (value, label) => {
    nonNegative(value, label);
    if (roundDecimal(value, MONEY_DECIMALS) !== value) throw new Error(`${label}必须精确到分`);
  };
  for (const p of data.products) { nonNegative(p.stock, '商品库存'); nonNegative(p.price, '商品单价'); nonNegative(p.safety_stock, '安全库存'); }
  for (const c of data.customers) moneyNonNegative(c.debt, '客户应收');
  for (const s of data.suppliers) moneyNonNegative(s.payable, '供应商应付');
  const timestamp = (value, label) => {
    if (value !== undefined && value !== null && (!Number.isSafeInteger(Number(value)) || Number(value) < 0)) throw new Error(`${label} timestamp is invalid`);
  };
  const allowedTransactionTypes = new Set(['in', 'out', 'adjustment']);
  const allowedLedgerTypes = new Set(['income', 'expense', 'receivable', 'payable', 'settlement']);
  const allowedOrderStatuses = new Set(ORDER_STATUSES);
  for (const t of data.transactions) {
    if (!productIds.has(Number(t.product_id))) throw new Error(`流水 ${t.id} 引用了不存在的商品`);
    nonNegative(t.quantity, '流水数量'); nonNegative(t.unit_price, '流水单价'); moneyNonNegative(t.amount, '流水金额');
    if (t.customer_id != null && !customerIds.has(Number(t.customer_id))) throw new Error(`流水 ${t.id} 引用了不存在的客户`);
    if (t.supplier_id != null && !supplierIds.has(Number(t.supplier_id))) throw new Error(`流水 ${t.id} 引用了不存在的供应商`);
    if (!allowedTransactionTypes.has(t.type)) throw new Error(`transaction ${t.id} type is invalid`);
    const expectedAmount = lineAmount(t.type === 'adjustment' ? Math.abs(Number(t.adjustment ?? t.quantity)) : Number(t.quantity), Number(t.unit_price));
    if (roundDecimal(Number(t.amount), 2) !== roundDecimal(expectedAmount, 2)) throw new Error(`transaction ${t.id} amount does not match quantity and unit price`);
    if (t.delivery_note_id != null && !deliveryNoteIds.has(Number(t.delivery_note_id))) throw new Error(`transaction ${t.id} references a missing delivery note`);
    if (t.type === 'adjustment' && (t.stocktake_id == null || !stocktakeIds.has(Number(t.stocktake_id)))) throw new Error(`盘点流水 ${t.id} 引用了不存在的盘点记录`);
    if (t.type === 'adjustment') {
      const take = data.stocktakes.find(row => Number(row.id) === Number(t.stocktake_id));
      if (take && (Number(t.product_id) !== Number(take.product_id)
        || roundDecimal(Number(t.adjustment ?? 0), 6) !== roundDecimal(Number(take.diff ?? 0), 6)
        || roundDecimal(Number(t.quantity), 6) !== roundDecimal(Math.abs(Number(take.diff ?? 0)), 6))) {
        throw new Error(`盘点流水 ${t.id} 与盘点记录不一致`);
      }
    }
    timestamp(t.created_at, `transaction ${t.id}`); timestamp(t.voided_at, `transaction ${t.id}`);
  }
  for (const entry of data.ledger) {
    moneyNonNegative(entry.amount, '账本金额');
    if (entry.party_id != null && !customerIds.has(Number(entry.party_id)) && !supplierIds.has(Number(entry.party_id))) throw new Error(`账本 ${entry.id} 引用了不存在的往来对象`);
    if (!allowedLedgerTypes.has(entry.type)) throw new Error(`ledger ${entry.id} type is invalid`);
    if (entry.transaction_id != null && !transactionIds.has(Number(entry.transaction_id))) throw new Error(`ledger ${entry.id} references a missing transaction`);
    if (entry.delivery_note_id != null && !deliveryNoteIds.has(Number(entry.delivery_note_id))) throw new Error(`ledger ${entry.id} references a missing delivery note`);
    timestamp(entry.created_at, `ledger ${entry.id}`); timestamp(entry.voided_at, `ledger ${entry.id}`);
  }
  for (const transaction of data.transactions.filter(row => row.type !== 'adjustment')) {
    const linked = data.ledger.filter(entry => Number(entry.transaction_id) === Number(transaction.id));
    const expectedPartyType = transaction.type === 'in' && transaction.supplier_id != null ? 'supplier'
      : transaction.type === 'out' && transaction.customer_id != null ? 'customer' : null;
    if (!expectedPartyType) {
      if (linked.length) throw new Error(`交易 ${transaction.id} 不应关联往来账本流水`);
      continue;
    }
    if (roundDecimal(Number(transaction.amount), 2) === 0) {
      if (linked.length) throw new Error(`交易 ${transaction.id} 零金额交易不应关联往来账本流水`);
      continue;
    }
    if (linked.length !== 1) throw new Error(`交易 ${transaction.id} 与账本流水不一致`);
    const entry = linked[0];
    const expectedType = expectedPartyType === 'supplier' ? 'payable' : 'receivable';
    const expectedPartyId = Number(expectedPartyType === 'supplier' ? transaction.supplier_id : transaction.customer_id);
    if (entry.type !== expectedType || Number(entry.party_id) !== expectedPartyId
      || ledgerPartyType(entry, data) !== expectedPartyType
      || Boolean(entry.voided_at) !== Boolean(transaction.voided_at)
      || roundDecimal(Number(entry.amount), MONEY_DECIMALS) !== roundDecimal(Number(transaction.amount), MONEY_DECIMALS)) {
      throw new Error(`交易 ${transaction.id} 与账本流水不一致`);
    }
  }
  for (const transaction of data.transactions.filter(row => row.type === 'adjustment')) {
    const linked = data.ledger.filter(entry => Number(entry.transaction_id) === Number(transaction.id));
    const active = linked.filter(entry => !entry.voided_at);
    const requiresLedger = Number(transaction.amount) > 0;
    if (transaction.voided_at ? active.length !== 0 : (requiresLedger ? active.length !== 1 : active.length !== 0)) throw new Error(`盘点流水 ${transaction.id} 与账本流水不一致`);
    if (active.length === 1 && roundDecimal(Number(active[0].amount), 2) !== roundDecimal(Number(transaction.amount), 2)) throw new Error(`盘点流水 ${transaction.id} 金额不一致`);
    const take = data.stocktakes.find(row => Number(row.id) === Number(transaction.stocktake_id));
    if (active.length === 1 && take && ((Number(take.diff) > 0 && active[0].type !== 'income') || (Number(take.diff) < 0 && active[0].type !== 'expense'))) throw new Error(`盘点流水 ${transaction.id} 收支方向不一致`);
  }
  for (const take of data.stocktakes) if (!productIds.has(Number(take.product_id))) throw new Error(`盘点 ${take.id} 引用了不存在的商品`);
  for (const order of data.orders) {
    if (!allowedOrderStatuses.has(order.status)) throw new Error(`order ${order.id} status is invalid`);
    nonNegative(order.quantity, 'order quantity'); nonNegative(order.unit_price, 'order unit price'); moneyNonNegative(order.amount, 'order amount');
    if (roundDecimal(Number(order.amount), 2) !== roundDecimal(lineAmount(Number(order.quantity), Number(order.unit_price)), 2)) throw new Error(`order ${order.id} amount does not match quantity and unit price`);
    timestamp(order.created_at, `order ${order.id}`);
  }
  for (const event of data.order_events) {
    if (!orderIds.has(Number(event.order_id))) throw new Error(`order event ${event.id} references a missing order`);
    if (!allowedOrderStatuses.has(event.from) || !allowedOrderStatuses.has(event.to)) throw new Error(`order event ${event.id} status is invalid`);
    timestamp(event.created_at, `order event ${event.id}`);
  }
  for (const take of data.stocktakes) {
    if (!productIds.has(Number(take.product_id))) throw new Error(`stocktake ${take.id} references a missing product`);
    if (take.before_stock !== undefined) nonNegative(take.before_stock, 'stocktake before stock');
    nonNegative(take.counted_stock, 'stocktake counted stock');
    if (take.before_stock !== undefined && take.diff !== undefined && roundDecimal(Number(take.diff), 6) !== roundDecimal(Number(take.counted_stock) - Number(take.before_stock), 6)) throw new Error(`stocktake ${take.id} diff is invalid`);
    timestamp(take.created_at, `stocktake ${take.id}`); timestamp(take.counted_at, `stocktake ${take.id}`);
  }
  for (const note of data.delivery_notes) {
    if (note.supplier_id != null && !supplierIds.has(Number(note.supplier_id))) throw new Error(`送货单 ${note.id} 引用了不存在的供应商`);
    const freight = note.freight === undefined ? 0 : note.freight;
    nonNegative(freight, '送货运费');
    lineAmount(1, Number(freight));
    if (!Array.isArray(note.lines)) throw new Error(`送货单 ${note.id} 明细格式无效`);
    for (const line of note.lines) if (!productIds.has(Number(line.product_id))) throw new Error(`送货单 ${note.id} 引用了不存在的商品`);
  }
  const transactionById = new Map(data.transactions.map(transaction => [Number(transaction.id), transaction]));
  for (const note of data.delivery_notes) {
    const freightAmount = lineAmount(1, Number(note.freight || 0));
    const freightLedgers = data.ledger.filter(entry => Number(entry.delivery_note_id) === Number(note.id) && entry.transaction_id == null);
    if (freightAmount > 0) {
      if (freightLedgers.length !== 1 || freightLedgers[0].type !== 'expense'
        || roundDecimal(Number(freightLedgers[0].amount), 2) !== freightAmount
        || Boolean(freightLedgers[0].voided_at) !== Boolean(note.voided_at)) {
        throw new Error(`送货单 ${note.id} 运费与账本流水不一致`);
      }
    } else if (freightLedgers.length !== 0) {
      throw new Error(`送货单 ${note.id} 不应包含运费账本流水`);
    }
    let totalAmount = 0; let totalSquareMeters = 0;
    for (const line of note.lines) {
      nonNegative(line.quantity, 'delivery planned quantity'); nonNegative(line.delivered_qty, 'delivery received quantity'); nonNegative(line.unit_price, 'delivery unit price'); moneyNonNegative(line.amount, 'delivery amount');
      if (line.transaction_id != null && !transactionIds.has(Number(line.transaction_id))) throw new Error(`delivery note ${note.id} references a missing transaction`);
      const transaction = line.transaction_id == null ? null : transactionById.get(Number(line.transaction_id));
      if (Number(line.delivered_qty) > 0 && !transaction) throw new Error(`送货单 ${note.id} 明细缺少对应入库流水`);
      if (transaction && (transaction.type !== 'in'
        || Number(transaction.delivery_note_id) !== Number(note.id)
        || Number(transaction.product_id) !== Number(line.product_id)
        || roundDecimal(Number(transaction.quantity), 6) !== roundDecimal(Number(line.delivered_qty), 6)
        || roundDecimal(Number(transaction.unit_price), 2) !== roundDecimal(Number(line.unit_price), 2)
        || roundDecimal(Number(transaction.amount), 2) !== roundDecimal(Number(line.amount), 2)
        || Boolean(transaction.voided_at) !== Boolean(note.voided_at))) {
        throw new Error(`送货单 ${note.id} 明细与入库流水不一致`);
      }
      if (roundDecimal(Number(line.amount), 2) !== roundDecimal(lineAmount(Number(line.delivered_qty), Number(line.unit_price)), 2)) throw new Error(`delivery note ${note.id} line amount is invalid`);
      totalAmount += Number(line.amount); totalSquareMeters += Number(line.square_meters || 0);
    }
    if (note.total_amount !== undefined) moneyNonNegative(note.total_amount, `送货单 ${note.id} 合计金额`);
    if (note.total_amount !== undefined && roundDecimal(Number(note.total_amount), 2) !== roundDecimal(totalAmount, 2)) throw new Error(`delivery note ${note.id} total amount is invalid`);
    if (note.total_square_meters !== undefined && roundDecimal(Number(note.total_square_meters), 4) !== roundDecimal(totalSquareMeters, 4)) throw new Error(`delivery note ${note.id} total area is invalid`);
    timestamp(note.created_at, `delivery note ${note.id}`); timestamp(note.voided_at, `delivery note ${note.id}`);
  }
}
function settleParty(partyType, id, amount, remark = '') {
  const isCustomer = partyType === 'customer';
  const party = isCustomer ? getCustomer(id) : getSupplier(id);
  if (!party) throw new Error(isCustomer ? '客户不存在' : '供应商不存在');
  if (party.deleted_at) throw new Error(isCustomer ? '客户已停用' : '供应商已停用');
  const field = isCustomer ? 'debt' : 'payable';
  const before = roundDecimal(Number(party[field] || 0), MONEY_DECIMALS);
  const payment = roundDecimal(numberValue(amount, '结算金额', true), MONEY_DECIMALS);
  if (payment > before) throw new Error(`结算金额不能超过当前${isCustomer ? '应收' : '应付'}余额 ${before} 元`);
  return atomicMutation(() => {
    party[field] = roundDecimal(before - payment, MONEY_DECIMALS);
    party.balance_updated_at = Date.now();
    systemLedger('settlement', payment, party.id, party.name, null, String(remark || '').trim() || `${isCustomer ? '客户' : '供应商'}结清 · ${party.name}`, isCustomer ? 'customer' : 'supplier');
    persist();
    return { party, settled: payment, balance: party[field] };
  });
}
function restoreSafetySnapshot() {
  if (!fs.existsSync(DB_PATH)) return null;
  createAutoBackup('restore');
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const target = path.join(BACKUP_DIR, `warehouse-data-restore-guard-${Date.now()}.json`);
    fs.copyFileSync(DB_PATH, target);
    try { fs.chmodSync(target, 0o600); } catch (error) { /* best effort */ }
    return target;
  } catch (error) {
    throw Object.assign(new Error(`恢复前无法备份当前数据，已中止恢复：${error.message}`), { status: 500 });
  }
}
function restoreData(value) {
  restoreSafetySnapshot();
  validateBackupData(value);
  const next = JSON.parse(JSON.stringify(value));
  // Older backups must not erase documents created in the new print center.
  if (next.print_notes === undefined) next.print_notes = JSON.parse(JSON.stringify(cache.print_notes || []));
  next.print_notes.forEach(note => {
    const current = (cache.print_notes || []).find(row => row.id === note.id);
    note.version = Math.max(note.version, current?.version || 0) + 1;
  });
  // Old backups predate the dimensions collection and must not erase it.
  const restoredDimensions = next.customer_dimensions === undefined ? getCustomerDimensions() : customerDimensions.validateDocument(next.customer_dimensions);
  next.customer_dimensions = { ...restoredDimensions, revision: Math.max(restoredDimensions.revision, getCustomerDimensions().revision) + 1 };
  const collaboration = cache._collaboration || { revision: 0, audit: [], receipts: {}, generation: 0 };
  // 恢复后的数据集与恢复前的回执不再对应：递增数据代次，旧回执重放会得到明确的 409 提示，而不是静默重新执行。
  collaboration.generation = (Number(collaboration.generation) || 0) + 1;
  next.orders = Array.isArray(next.orders) ? next.orders : []; next.order_events = Array.isArray(next.order_events) ? next.order_events : []; next.stocktakes = Array.isArray(next.stocktakes) ? next.stocktakes : []; next.delivery_notes = Array.isArray(next.delivery_notes) ? next.delivery_notes : [];
  next.products = (next.products || []).map(product => ({ ...product, image_url: portableImageUrl(product.image_url) }));
  if (!next._meta) next._meta = {};
  next._meta.schemaVersion = SCHEMA_VERSION;
  for (const [collection, counter] of [['products','nextProductId'],['customers','nextCustomerId'],['suppliers','nextSupplierId'],['transactions','nextTransactionId'],['ledger','nextLedgerId'],['orders','nextOrderId'],['delivery_notes','nextDeliveryNoteId'],['order_events','nextOrderEventId'],['stocktakes','nextStocktakeId']]) { next[collection] = Array.isArray(next[collection]) ? next[collection] : []; next._meta[counter] = next[collection].reduce((n, row) => Math.max(n, Number(row.id) + 1), Number(next._meta[counter]) || 1); }
  normalizeGhostStock(next, 'restore');
  ledgerAttachments.restore(next);
  delete next.ledger_attachment_files;
  next._collaboration = collaboration;
  cache = next; persist(); return stats();
}

function getCustomerDimensions() { return JSON.parse(JSON.stringify(cache.customer_dimensions)); }
function updateCustomerDimensions(raw) {
  return atomicMutation(() => {
    const previous = cache.customer_dimensions;
    if (raw?.revision !== previous.revision) throw Object.assign(new Error('资料已更新，请刷新后重试'), { status: 409 });
    const next = { schemaVersion: 1, revision: previous.revision + 1, ...customerDimensions.validate(raw) };
    cache.customer_dimensions = next;
    persist();
    return getCustomerDimensions();
  });
}
function listPrintNotes(keyword) { return JSON.parse(JSON.stringify(require('./print-notes').list(cache, keyword))); }
function savePrintNote(raw, id) { return atomicMutation(() => { const note = require('./print-notes').save(cache, raw, id); persist(); return note; }); }
function shipPrintNote(id) {
  return atomicMutation(() => {
    const note = cache.print_notes.find(row => row.id === Number(id));
    if (!note) throw Object.assign(new Error('送货单不存在'), { status: 404 });
    if (note.outbound_at) return JSON.parse(JSON.stringify(note));
    const seen = new Set();
    const lines = note.items.map(item => {
      let product = item.product_id == null ? null : cache.products.find(row => row.id === Number(item.product_id) && !row.deleted_at);
      if (!product) {
        const matches = cache.products.filter(row => !row.deleted_at && row.unit === '个' && row.name === item.name && String(row.specification || '') === String(item.specification || ''));
        if (matches.length !== 1) throw new Error('商品无法唯一匹配库存，请先在商品管理核对名称和规格');
        product = matches[0]; item.product_id = product.id;
      }
      if (product.unit !== '个') throw new Error('库存商品单位不是个，不能从送货单出库');
      if (seen.has(product.id)) throw new Error('同一商品重复出现，请合并送货明细');
      seen.add(product.id);
      return { product_id: product.id, quantity: item.quantity, specification: item.specification, unit: '个', unit_price: item.price, remark: item.remark };
    });
    const outboundNo = 'CK' + String(cache._meta.nextTransactionId).padStart(8, '0');
    const results = stockOutBatch(lines, note.sender || '送货单出库', '送货单 ' + note.number, note.customer_id || null);
    const now = Date.now();
    const transactionIds = results.map(result => { Object.assign(result.transaction, { outbound_no: outboundNo, print_note_id: note.id }); return result.transaction.id; });
    note.outbound_at = now; note.outbound_no = outboundNo; note.transaction_ids = transactionIds; note.version = Number(note.version || 1) + 1; note.updated_at = now;
    persist(); return JSON.parse(JSON.stringify(note));
  });
}
function listBoards() { return require('./boards').list(cache); }
function receiveBoard(raw) { return atomicMutation(() => { const batch = require('./boards').receive(cache, raw); persist(); return batch; }); }
function moveBoard(id, raw) { return atomicMutation(() => { const batch = require('./boards').move(cache, id, raw); persist(); return batch; }); }
function updateBoard(id, raw) { return atomicMutation(() => { const result = require('./boards').update(cache, id, raw); persist(); return result; }); }
function deleteBoard(id) { return atomicMutation(() => { const result = require('./boards').remove(cache, id); persist(); return result; }); }
module.exports = { listPrintNotes, savePrintNote, shipPrintNote, getCustomerDimensions, updateCustomerDimensions, listBoards, receiveBoard, moveBoard, updateBoard, deleteBoard, listProducts, getProduct, addProduct, updateProduct, deleteProduct,
  getLedgerAttachments, addLedgerAttachment, readLedgerAttachment, prepareLedgerAttachment: ledgerAttachments.prepare,
  listCustomers, getCustomer, addCustomer, updateCustomer, deleteCustomer,
  listSuppliers, getSupplier, addSupplier, updateSupplier, deleteSupplier,
  stockIn, stockOut, stockOutBatch, orderToOutbound, listTx, streamTx, deleteTransaction, listLedger, streamLedger, addLedger, deleteLedger, listOrders, listOrderEvents, addOrder, updateOrder, addStocktake, listStocktakes, listDeliveryNotes, getDeliveryNote, addDeliveryNote, voidDeliveryNote, backupData, restoreData, health, stats, transact, revision, audit, receipt, settleParty };
