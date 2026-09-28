const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const install = require('./team');

test('stock workflows use isolated data and real HTTP routes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-stock-test-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(dir, 'accounts.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  await install.bootstrap(process.env.WAREHOUSE_ACCOUNTS_FILE, 'Stock-test-password!');
  const db = require('./db');
  const app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api', install(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  let token = ''; let sequence = 0;
  async function call(url, method = 'GET', body, key = `stock-regression-${++sequence}`, rev = db.revision()) {
    const response = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key, 'If-Match': String(rev) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(raw) : raw };
  }
  async function create(url, body) { const r = await call(url, 'POST', body); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data; }
  const product = extra => create('/products', { name: '测试纸板', specification: '1000×500/B', unit: '张', price: 2.5, stock: 20, ...extra });
  const delivery = (p, extra = {}) => ({ date: '2026-09-26', freight: 5, lines: [{ product_id: p.id, specification: p.specification, quantity: 10, delivered_qty: 8, unit_price: 2.5 }], ...extra });
  async function unchanged(url, body, pattern) {
    const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
    const r = await call(url, 'POST', body); assert.equal(r.status, 400, JSON.stringify(r.body));
    if (pattern) assert.match(r.body.message, pattern);
    assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
  }
  try {
    token = (await call('/auth/login', 'POST', { username: 'admin', password: 'Stock-test-password!' })).body.data.token;
    await t.test('supplier rename preserves historical snapshots and uses current name for new receipts', async () => {
      const s = await create('/suppliers', { name: 'Original supplier' });
      const p = await product({ supplier_id: s.id });
      const note = await create('/delivery-notes', delivery(p, { supplier_id: s.id }));
      const txId = note.lines[0].transaction_id;
      const before = db.backupData();
      const renamed = await call(`/suppliers/${s.id}`, 'PUT', { name: 'Renamed supplier' });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      const after = db.backupData();
      assert.deepEqual(after.transactions, before.transactions, 'renaming must not rewrite posted transactions');
      assert.deepEqual(after.delivery_notes, before.delivery_notes);
      assert.deepEqual(after.ledger, before.ledger);
      assert.equal(db.getProduct(p.id).supplier_name, 'Renamed supplier');
      const response = await call(`/transactions?supplier_id=${s.id}`);
      assert.equal(response.status, 200);
      assert.equal(db.listTx({ supplier_id: s.id }).find(tx => tx.id === txId).supplier_name, 'Original supplier');
      assert.equal(db.listTx({ supplier_id: s.id }).find(tx => tx.id === txId).supplier_current_name, 'Renamed supplier');
      assert.equal(db.backupData().transactions.find(tx => tx.id === txId).supplier_current_name, undefined, 'current name is read-time metadata only');
      const csv = await call(`/delivery-notes/${note.id}.csv`);
      assert.match(csv.body, /Original supplier/);
      assert.doesNotMatch(csv.body, /Renamed supplier/);
      const next = await create('/delivery-notes', delivery(p, { supplier_id: s.id }));
      assert.equal(next.supplier_name, 'Renamed supplier');
      const disk = JSON.parse(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'));
      assert.equal(disk.transactions.find(tx => tx.id === txId).supplier_name, 'Original supplier');
      assert.equal(disk.transactions.find(tx => tx.id === next.lines[0].transaction_id).supplier_name, 'Renamed supplier');
      assert.equal(db.getSupplier(s.id).payable, note.total_amount + next.total_amount);
    });
    await t.test('actual receipt quantity drives stock, amount, area and payable', async () => {
      const p = await product({ length: 1200, width: 600 }); const s = await create('/suppliers', { name: '测试供应商' });
      const note = await create('/delivery-notes', delivery(p, { supplier_id: s.id, operator: '验收员' }));
      assert.equal(db.getProduct(p.id).stock, 28); assert.equal(note.total_amount, 20); assert.equal(note.total_square_meters, 5.76);
      assert.equal(db.getSupplier(s.id).payable, 20); assert.equal(note.lines[0].unit, '张');
      assert.equal(db.listTx({ product_id: p.id })[0].operator, '验收员');
      const generatedLedger = db.listLedger({ type: 'payable' }).find(entry => entry.transaction_id === note.lines[0].transaction_id);
      assert.throws(() => db.deleteLedger(generatedLedger.id), /请通过原单作废/);
      const csv = await call(`/delivery-notes/${note.id}.csv`);
      assert.equal(csv.status, 200);
      assert.match(csv.body, /实际入库/);
      assert.match(csv.body, /"8"/);
      assert.match(csv.body, /"运费（单独记录，不计入货款应付）","5"/);
      assert.match(csv.body, /"货款合计","","","","","","","20"/, 'goods total excludes freight');
      assert.match(csv.body, /"总平米","5\.76"/, 'CSV area total equals the delivery note and UI preview');
      const rawCsvResponse = await fetch(`${origin}/delivery-notes/${note.id}.csv`, { headers: { Authorization: `Bearer ${token}` } });
      const csvBytes = new Uint8Array(await rawCsvResponse.arrayBuffer());
      assert.deepEqual(Array.from(csvBytes.slice(0, 3)), [0xef, 0xbb, 0xbf], 'delivery CSV must include a UTF-8 BOM');
    });
    await t.test('delivery note remark matches the 500-character client limit', async () => {
      const p = await product({ name: '送货单备注长度商品', stock: 0 });
      const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
      const tooLong = await call('/delivery-notes', 'POST', delivery(p, { remark: 'R'.repeat(501) }));
      assert.equal(tooLong.status, 400, JSON.stringify(tooLong.body));
      assert.match(tooLong.body.message, /remark 长度不能超过 500/);
      assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
      const valid = await create('/delivery-notes', delivery(p, { remark: 'R'.repeat(500) }));
      assert.equal(valid.remark.length, 500);
    });
    await t.test('backdated delivery notes do not count in today inbound statistics', async () => {
      const p = await product({ name: '补录日期统计商品', stock: 0 });
      const now = new Date(); const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const date = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
      const before = db.stats();
      const note = await create('/delivery-notes', delivery(p, { date }));
      assert.equal(note.date, date);
      const after = db.stats();
      assert.equal(after.todayIn, before.todayIn, 'a backdated receipt is excluded from today count');
      assert.equal(db.getProduct(p.id).stock, 8);
    });
    await t.test('product edits do not rewrite historical transaction snapshots', async () => {
      const p = await product({ name: '历史快照商品', price: 2.5, specification: '旧规格' });
      const before = await create('/stock/in', { product_id: p.id, quantity: 2, unit_price: 2.5 });
      const changed = await call(`/products/${p.id}`, 'PUT', { price: 9.9, specification: '新规格' }, `snapshot-product-${++sequence}`, db.revision());
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      const historical = db.listTx({ product_id: p.id }).find(tx => tx.id === before.transaction.id);
      assert.equal(historical.unit_price, 2.5);
      assert.equal(historical.amount, 5);
      assert.equal(historical.specification, '旧规格');
      assert.equal(db.getProduct(p.id).price, 9.9);
      assert.equal(db.getProduct(p.id).specification, '新规格');
      const order = await create('/orders', { order_no: 'ORDER-SERVER-CREATED-AT', quantity: 1, unit_price: 2 });
      const originalCreatedAt = order.created_at;
      const directChanged = db.updateOrder(order.id, { remark: '业务更新', created_at: 1, updated_at: 1 });
      assert.equal(directChanged.created_at, originalCreatedAt, 'direct updates cannot forge created_at');
      assert.equal(directChanged.remark, '业务更新');
    });
    await t.test('multi-line goods amounts round per line and reconcile to supplier payable', async () => {
      const s = await create('/suppliers', { name: '舍入供应商' });
      const a = await product({ name: '舍入甲', price: 0.01 });
      const b = await product({ name: '舍入乙', price: 0.02 });
      const note = await create('/delivery-notes', { date: '2026-09-26', supplier_id: s.id, lines: [
        { product_id: a.id, quantity: 3, delivered_qty: 3, unit_price: 0.01 },
        { product_id: b.id, quantity: 3, delivered_qty: 3, unit_price: 0.02 }
      ] });
      const lineSum = note.lines.reduce((sum, line) => sum + line.amount, 0);
      assert.equal(note.total_amount, lineSum);
      assert.equal(db.getSupplier(s.id).payable, note.total_amount);
      const payable = db.listLedger({ type: 'payable' }).filter(entry => entry.transaction_id && note.lines.some(line => line.transaction_id === entry.transaction_id));
      assert.equal(payable.reduce((sum, entry) => sum + entry.amount, 0), note.total_amount);
    });
    await t.test('multi-line outbound amounts reconcile to customer receivable', async () => {
      const c = await create('/customers', { name: '舍入客户' });
      const a = await product({ name: '出库舍入甲', price: 0.01, stock: 3 });
      const b = await product({ name: '出库舍入乙', price: 0.02, stock: 3 });
      const result = await create('/stock/out/batch', { customer_id: c.id, lines: [
        { product_id: a.id, quantity: 3, unit_price: 0.01 },
        { product_id: b.id, quantity: 3, unit_price: 0.02 }
      ] });
      const total = result.transactions.reduce((sum, item) => sum + item.transaction.amount, 0);
      assert.equal(db.getCustomer(c.id).debt, total);
      const receivable = db.listLedger({ type: 'receivable' }).filter(entry => result.transactions.some(item => item.transaction.id === entry.transaction_id));
      assert.equal(receivable.reduce((sum, entry) => sum + entry.amount, 0), total);
    });
    await t.test('voided ledger entries stay out of default lists until history is requested', async () => {
      const entry = db.addLedger({ type: 'income', amount: 12.34, remark: '可作废手工流水' });
      assert.equal(db.listLedger({}).some(item => item.id === entry.id), true);
      db.deleteLedger(entry.id);
      assert.equal(db.listLedger({}).some(item => item.id === entry.id), false);
      const history = db.listLedger({ include_voided: 'true' }).find(item => item.id === entry.id);
      assert.equal(history?.voided_at > 0, true);
    });
    await t.test('ledger reads expose current party names without rewriting snapshots', async () => {
      const customer = await create('/customers', { name: '账本旧客户名', debt: 2 });
      const before = db.backupData();
      const changed = await call(`/customers/${customer.id}`, 'PUT', { name: '账本现客户名' }, `ledger-party-rename-${++sequence}`, db.revision());
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      const entry = db.listLedger({ type: 'receivable' }).find(row => row.party_id === customer.id);
      assert.equal(entry.party_name, '账本旧客户名');
      assert.equal(entry.party_current_name, '账本现客户名');
      assert.equal(db.backupData().ledger.find(row => row.id === entry.id).party_current_name, undefined);
      assert.equal(db.backupData().ledger.find(row => row.id === entry.id).party_name, before.ledger.find(row => row.id === entry.id).party_name);
    });
    await t.test('customer and supplier settlements keep balances equal to typed ledger totals', async () => {
      const customer = await create('/customers', { name: 'settlement customer', debt: 0.3 });
      const supplier = await create('/suppliers', { name: '舍入结算供应商', payable: 0.3 });
      const customerUpdate = await call(`/customers/${customer.id}`, 'PUT', { debt: 0.1 }, `settlement-customer-${++sequence}`, db.revision());
      const supplierUpdate = await call(`/suppliers/${supplier.id}`, 'PUT', { payable: 0.1 }, `settlement-supplier-${++sequence}`, db.revision());
      assert.equal(customerUpdate.status, 200, JSON.stringify(customerUpdate.body));
      assert.equal(supplierUpdate.status, 200, JSON.stringify(supplierUpdate.body));
      assert.equal(db.getCustomer(customer.id).debt, 0.1);
      assert.equal(db.getSupplier(supplier.id).payable, 0.1);
      assert.deepEqual(
        db.listLedger({ include_voided: 'true' }).filter(row => row.party_id === customer.id && row.party_type === 'customer').map(row => [row.type, row.party_type, row.amount]).sort((a, b) => a[0].localeCompare(b[0])),
        [['receivable', 'customer', 0.3], ['settlement', 'customer', 0.2]]
      );
      assert.deepEqual(
        db.listLedger({ include_voided: 'true' }).filter(row => row.party_id === supplier.id && row.party_type === 'supplier').map(row => [row.type, row.party_type, row.amount]).sort((a, b) => a[0].localeCompare(b[0])),
        [['payable', 'supplier', 0.3], ['settlement', 'supplier', 0.2]]
      );
    });
    await t.test('settlement rounds balances to cents and rejects stale concurrent clearings', async () => {
      const rounded = await create('/customers', { name: '分币结算客户', debt: 1.005 });
      assert.equal(rounded.debt, 1.01);
      const customer = await create('/customers', { name: '并发结清客户', debt: 10 });
      const partial = await call(`/customers/${customer.id}`, 'PUT', { debt: 6 }, `settlement-partial-${++sequence}`, db.revision());
      assert.equal(partial.status, 200, JSON.stringify(partial.body));
      const revision = db.revision();
      const results = await Promise.all([
        call(`/customers/${customer.id}`, 'PUT', { debt: 0 }, `settlement-clear-001-${++sequence}`, revision),
        call(`/customers/${customer.id}`, 'PUT', { debt: 0 }, `settlement-clear-002-${++sequence}`, revision)
      ]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      assert.equal(db.getCustomer(customer.id).debt, 0);
      const settlements = db.listLedger({ type: 'settlement' }).filter(entry => entry.party_id === customer.id && entry.party_type === 'customer');
      assert.deepEqual(settlements.map(entry => entry.amount).sort((a, b) => a - b), [4, 6]);
    });
    await t.test('accounting invariant failure rolls back the whole transaction', async () => {
      const p = await product({ name: '恒等式回滚商品', stock: 2 });
      const before = db.backupData();
      assert.throws(() => db.transact({ id: 9001, username: 'admin' }, 'accounting-invariant-test', 'accounting-invariant-test-fingerprint', String(db.revision()), 'test accounting invariant', () => {
        db.getProduct(p.id).stock = 3;
        return { id: p.id };
      }), /库存与出入库流水不一致/);
      assert.deepEqual(db.backupData(), before);
    });
    await t.test('duplicate or missing inbound products never create records or products', async () => {
      const p = await product(); const body = delivery(p); body.lines.push(body.lines[0]);
      await unchanged('/delivery-notes', body, /重复/);
      body.lines = [{ ...body.lines[0], product_id: 999999 }]; await unchanged('/delivery-notes', body, /商品/);
    });
    await t.test('invalid prices, quantities, freight and date are rejected atomically', async () => {
      const p = await product();
      for (const bad of [-1, 'abc', null, '', true]) {
        const body = delivery(p); body.lines[0].unit_price = bad;
        await unchanged('/delivery-notes', body);
        await unchanged('/stock/out/batch', { lines: [{ product_id: p.id, quantity: 1, unit_price: bad }] });
      }
      for (const bad of [0, -1, 'abc', null, '', true, 0.0000001]) await unchanged('/stock/out/batch', { lines: [{ product_id: p.id, quantity: bad }] });
      await unchanged('/delivery-notes', delivery(p, { freight: -1 }));
      await unchanged('/delivery-notes', delivery(p, { date: '2026-02-30' }));
    });
    await t.test('overflow line amounts return a Chinese client error without changing stock', async () => {
      const p = await product({ name: '金额上限商品', stock: 20 });
      const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
      const result = await call('/stock/out/batch', 'POST', { lines: [{ product_id: p.id, quantity: 1000000000, unit_price: 1000000000 }] });
      assert.equal(result.status, 400, JSON.stringify(result.body));
      assert.match(result.body.message, /金额超出支持范围/);
      assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
      assert.equal(db.getProduct(p.id).stock, 20);
    });
    await t.test('inactive suppliers, customers and products cannot post stock', async () => {
      const p = await product(); const s = await create('/suppliers', { name: '停用供应商' }); const c = await create('/customers', { name: '停用客户' });
      await call(`/suppliers/${s.id}`, 'DELETE'); await call(`/customers/${c.id}`, 'DELETE');
      await unchanged('/delivery-notes', delivery(p, { supplier_id: s.id }));
      await unchanged('/stock/in', { product_id: p.id, quantity: 1, supplier_id: s.id });
      await unchanged('/stock/out/batch', { customer_id: c.id, lines: [{ product_id: p.id, quantity: 1 }] });
      await call(`/products/${p.id}`, 'DELETE');
      await unchanged('/stock/out/batch', { lines: [{ product_id: p.id, quantity: 1 }] });
      await unchanged('/delivery-notes', delivery(p));
    });
    await t.test('inactive products keep historical transaction snapshots readable', async () => {
      const p = await product({ name: '停用后仍可查商品', price: 3.25, stock: 4 });
      const posted = await create('/stock/out', { product_id: p.id, quantity: 2, unit_price: 3.25 });
      const disabled = await call(`/products/${p.id}`, 'DELETE');
      assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
      const history = db.listTx({ product_id: p.id }).find(tx => tx.id === posted.transaction.id);
      assert.equal(history.product_name, '停用后仍可查商品');
      assert.equal(history.quantity, 2);
      assert.equal(history.amount, 6.5);
      assert.equal(db.getProduct(p.id).deleted_at > 0, true);
    });
    await t.test('insufficient stock or a bad last line rolls back the entire batch', async () => {
      const a = await product(); const b = await product({ stock: 1 });
      await unchanged('/stock/out/batch', { lines: [{ product_id: a.id, quantity: 2 }, { product_id: b.id, quantity: 2 }] }, /库存不足/);
      await unchanged('/stock/out/batch', { lines: [{ product_id: a.id, quantity: 2 }, { product_id: b.id, quantity: 1, unit_price: -1 }] });
      await unchanged('/stock/out/batch', { lines: [{ product_id: a.id, quantity: 1 }, { product_id: a.id, quantity: 1 }] }, /重复/);
    });
    await t.test('multi-line posting and retry affect stock and debt exactly once', async () => {
      const a = await product(); const b = await product(); const c = await create('/customers', { name: '测试客户' });
      const body = { customer_id: c.id, lines: [{ product_id: a.id, quantity: 3, unit_price: 1.005 }, { product_id: b.id, quantity: 2, unit_price: 0.335 }] };
      const revision = db.revision(); const first = await call('/stock/out/batch', 'POST', body, 'repeat-batch-request', revision);
      assert.equal(first.status, 200); assert.equal(db.getProduct(a.id).stock, 17); assert.equal(db.getProduct(b.id).stock, 18); assert.equal(db.getCustomer(c.id).debt, 3.69);
      const before = db.backupData(); const second = await call('/stock/out/batch', 'POST', body, 'repeat-batch-request', revision);
      assert.deepEqual(second.body, first.body); assert.deepEqual(db.backupData(), before);
    });
    await t.test('decimal quantities and computed money cannot drift or be overridden', async () => {
      const p = await product({ stock: 0.3 });
      await create('/stock/out', { product_id: p.id, quantity: 0.1, unit_price: 1 });
      await create('/stock/out', { product_id: p.id, quantity: 0.2, unit_price: 1 }); assert.equal(db.getProduct(p.id).stock, 0);
      const result = await create('/stock/in', { product_id: p.id, quantity: 2, unit_price: 5, amount: 1 }); assert.equal(result.transaction.amount, 10);
      await unchanged('/stock/out/batch', { lines: [{ product_id: p.id, quantity: 1, unit: '箱' }] }, /单位/);
    });
    await t.test('stock transaction timestamps come from the server', async () => {
      const p = await product({ name: '服务端时间商品', stock: 0 });
      const before = Date.now();
      const result = await call('/stock/in', 'POST', { product_id: p.id, quantity: 1, unit_price: 2, recorded_at: 1 }, `server-time-stock-${++sequence}`, db.revision());
      const after = Date.now();
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(result.body.data.transaction.created_at >= before);
      assert.ok(result.body.data.transaction.created_at <= after);
    });
    await t.test('decimal outbound quantities use six-place precision and reject smaller fractions', async () => {
      const p = await product({ stock: 1.000001 });
      const first = await create('/stock/out/batch', { lines: [{ product_id: p.id, quantity: 0.000001, unit_price: 1 }] });
      assert.equal(first.transactions[0].transaction.quantity, 0.000001);
      assert.equal(db.getProduct(p.id).stock, 1);
      await unchanged('/stock/out/batch', { lines: [{ product_id: p.id, quantity: 0.0000001, unit_price: 1 }] }, /最多支持六位小数/);
      assert.equal(db.getProduct(p.id).stock, 1);
    });
    await t.test('void keeps history and reverses stock and debt only once', async () => {
      const p = await product(); const c = await create('/customers', { name: '作废客户' });
      const result = await create('/stock/out', { product_id: p.id, quantity: 2, customer_id: c.id }); const id = result.transaction.id;
      assert.equal((await call(`/transactions/${id}`, 'DELETE')).status, 200);
      assert.equal(db.getProduct(p.id).stock, 20); assert.equal(db.getCustomer(c.id).debt, 0);
      assert(db.backupData().transactions.find(x => x.id === id).voided_at); assert(db.backupData().ledger.find(x => x.transaction_id === id).voided_at);
      assert.equal(db.listTx({ product_id: p.id }).length, 0);
      assert.equal((await call(`/transactions/${id}`, 'DELETE')).status, 400); assert.equal(db.getProduct(p.id).stock, 20);
    });
    await t.test('delivery note void is all-or-nothing and keeps original details', async () => {
      const a = await product({ stock: 0 }); const b = await product({ stock: 0 }); const s = await create('/suppliers', { name: '作废供应商' });
      const body = delivery(a, { supplier_id: s.id }); body.lines.push({ ...body.lines[0], product_id: b.id });
      const note = await create('/delivery-notes', body);
      assert.equal((await call(`/transactions/${note.lines[0].transaction_id}`, 'DELETE')).status, 400);
      const out = await create('/stock/out', { product_id: b.id, quantity: 1 });
      const before = db.backupData(); assert.equal((await call(`/delivery-notes/${note.id}`, 'DELETE')).status, 400); assert.deepEqual(db.backupData(), before);
      await call(`/transactions/${out.transaction.id}`, 'DELETE');
      assert.equal((await call(`/delivery-notes/${note.id}`, 'DELETE')).status, 200);
      assert.equal(db.getProduct(a.id).stock, 0); assert.equal(db.getProduct(b.id).stock, 0); assert.equal(db.getSupplier(s.id).payable, 0);
      assert(db.getDeliveryNote(note.id).voided_at); assert.equal(db.getDeliveryNote(note.id).lines.length, 2);
    });
    await t.test('orders validate amounts and follow the allowed status flow', async () => {
      const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
      for (const body of [
        { order_no: '   ', quantity: 1 },
        { order_no: 'ORD-invalid-0', quantity: 0 },
        { order_no: 'ORD-invalid-negative', quantity: -1 },
        { order_no: 'ORD-invalid-text', quantity: 'abc' },
        { order_no: 'ORD-invalid-price', quantity: 1, unit_price: -1 }
      ]) {
        const result = await call('/orders', 'POST', body);
        assert.equal(result.status, 400, JSON.stringify(result.body));
        assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
      }
      const created = await create('/orders', { order_no: 'ORD-001', quantity: 2, unit_price: 3 });
      assert.equal(created.amount, 6);
      const duplicate = await call('/orders', 'POST', { order_no: 'ORD-001', quantity: 1 });
      assert.equal(duplicate.status, 409);
      const concurrentOrderRevision = db.revision();
      const concurrentOrders = await Promise.all([
        call('/orders', 'POST', { order_no: 'ORD-CONCURRENT', quantity: 1 }, `order-duplicate-001-${++sequence}`, concurrentOrderRevision),
        call('/orders', 'POST', { order_no: 'ORD-CONCURRENT', quantity: 1 }, `order-duplicate-002-${++sequence}`, concurrentOrderRevision)
      ]);
      assert.deepEqual(concurrentOrders.map(result => result.status).sort(), [200, 409]);
      const secondOrder = await create('/orders', { order_no: 'ORD-SECOND', quantity: 1 });
      const renameConflict = await call(`/orders/${secondOrder.id}`, 'PUT', { order_no: 'ORD-CONCURRENT' }, `order-rename-conflict-${++sequence}`, db.revision());
      assert.equal(renameConflict.status, 409);
      const changed = await call(`/orders/${created.id}`, 'PUT', { quantity: 3, unit_price: 2 }, `stock-order-update-${++sequence}`, db.revision());
      assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.data.amount, 6);
      const transitions = ['\u751f\u4ea7\u4e2d', '\u5df2\u53d1\u8d27', '\u5df2\u5b8c\u6210'];
      for (const status of transitions) {
        const result = await call(`/orders/${created.id}`, 'PUT', { status }, `stock-order-status-${++sequence}`, db.revision());
        assert.equal(result.status, 200, JSON.stringify(result.body));
      }
      const completedUpdate = await call(`/orders/${created.id}`, 'PUT', { status: '\u5df2\u53d6\u6d88' }, `stock-order-invalid-transition-${++sequence}`, db.revision());
      assert.equal(completedUpdate.status, 400);
      const zeroQuantity = await call(`/orders/${created.id}`, 'PUT', { quantity: 0 }, `stock-order-zero-quantity-${++sequence}`, db.revision());
      assert.equal(zeroQuantity.status, 400);
      const cancelled = await create('/orders', { order_no: 'ORD-002', quantity: 1 });
      const cancelResult = await call(`/orders/${cancelled.id}`, 'PUT', { status: '\u5df2\u53d6\u6d88' }, `stock-order-cancel-${++sequence}`, db.revision());
      assert.equal(cancelResult.status, 200);
      const resume = await call(`/orders/${cancelled.id}`, 'PUT', { status: '\u751f\u4ea7\u4e2d' }, `stock-order-resume-${++sequence}`, db.revision());
      assert.equal(resume.status, 400);
      assert.equal(db.listOrderEvents(created.id).length, 3);
    });
    await t.test('orders keep customer snapshot and continue status flow after customer deactivation', async () => {
      const customer = await create('/customers', { name: '\u8ba2\u5355\u5ba2\u6237\u5feb\u7167' });
      const order = await create('/orders', { order_no: 'ORD-CUSTOMER-SNAPSHOT', customer_id: customer.id, customer_name: '\u4f2a\u9020\u540d\u79f0', quantity: 1, unit_price: 2 });
      assert.equal(order.customer_name, '\u8ba2\u5355\u5ba2\u6237\u5feb\u7167');
      const disabled = await call(`/customers/${customer.id}`, 'DELETE', undefined, `order-customer-disable-${++sequence}`, db.revision());
      assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
      const listed = await call('/orders?keyword=ORD-CUSTOMER-SNAPSHOT');
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.equal(listed.body.data[0].customer_name, '\u8ba2\u5355\u5ba2\u6237\u5feb\u7167');
      const transitioned = await call(`/orders/${order.id}`, 'PUT', { status: '\u751f\u4ea7\u4e2d' }, `order-customer-transition-${++sequence}`, db.revision());
      assert.equal(transitioned.status, 200, JSON.stringify(transitioned.body));
      assert.equal(transitioned.body.data.customer_name, '\u8ba2\u5355\u5ba2\u6237\u5feb\u7167');
    });
    await t.test('stocktakes reject invalid values and dates atomically', async () => {
      const p = await product({ stock: 5 });
      const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
      for (const counted_stock of [-1, 'abc', '', null, true, 0.0000001]) {
        const result = await call('/stocktake', 'POST', { product_id: p.id, counted_stock, counted_at: '2026-09-26' });
        assert.equal(result.status, 400, JSON.stringify(result.body));
        assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
      }
      const invalidDate = await call('/stocktake', 'POST', { product_id: p.id, counted_stock: 6, counted_at: '2026-02-30' });
      assert.equal(invalidDate.status, 400, JSON.stringify(invalidDate.body));
      assert.equal(db.getProduct(p.id).stock, 5);
      const valid = await create('/stocktake', { product_id: p.id, counted_stock: 6, counted_at: '2026-09-26', remark: 'cycle count' });
      assert.equal(valid.stocktake.counted_stock, 6);
      assert.equal(db.getProduct(p.id).stock, 6);
      assert.equal(db.listStocktakes({ product_id: p.id }).length, 1);
      const adjustment = db.listTx({ product_id: p.id }).find(tx => tx.type === 'adjustment');
      assert.ok(adjustment);
      assert.throws(() => db.deleteTransaction(adjustment.id), /库存页打开盘点弹窗重新盘点修正/);
    });
    await t.test('direct stocktake mutation rolls back all state when amount validation fails', async () => {
      const p = await product({ name: '盘点原子回滚商品', stock: 5, price: 9000000000 });
      const before = {
        stock: db.getProduct(p.id).stock,
        stocktakes: db.listStocktakes({ product_id: p.id }).length,
        transactions: db.listTx({ product_id: p.id }).length,
        ledger: db.listLedger({ include_voided: 'true' }).length
      };
      // A valid but very large unit price with a large count overflows the
      // amount limit. The operation must remain atomic.
      assert.throws(() => db.addStocktake({ product_id: p.id, counted_stock: 100000 }), /金额超出支持范围/);
      assert.deepEqual({
        stock: db.getProduct(p.id).stock,
        stocktakes: db.listStocktakes({ product_id: p.id }).length,
        transactions: db.listTx({ product_id: p.id }).length,
        ledger: db.listLedger({ include_voided: 'true' }).length
      }, { ...before, stock: 5 });
    });
    await t.test('accounting invariant rejects duplicate ledgers for a stocktake adjustment', async () => {
      const p = await product({ name: '盘点重复账本商品', stock: 5, price: 2 });
      const before = db.backupData();
      assert.throws(() => db.transact({ id: 9021, username: 'admin' }, `stocktake-ledger-${++sequence}`, 'stocktake-ledger-fingerprint', String(db.revision()), 'test stocktake ledger invariant', () => {
        const result = db.addStocktake({ product_id: p.id, counted_stock: 6 });
        const adjustment = db.listTx({ product_id: p.id }).find(tx => tx.type === 'adjustment' && tx.stocktake_id === result.stocktake.id);
        db.addLedger({ type: 'income', amount: 1, transaction_id: adjustment.id });
        return result;
      }), /盘点流水.*账本流水不一致/);
      assert.deepEqual(db.backupData(), before);
    });
    await t.test('accounting invariant rejects a stocktake ledger with the wrong direction', async () => {
      const p = await product({ name: '盘点方向商品', stock: 5, price: 2 });
      const before = db.backupData();
      assert.throws(() => db.transact({ id: 9022, username: 'admin' }, `stocktake-direction-${++sequence}`, 'stocktake-direction-fingerprint', String(db.revision()), 'test stocktake direction invariant', () => {
        const result = db.addStocktake({ product_id: p.id, counted_stock: 6 });
        const adjustment = db.listTx({ product_id: p.id }).find(tx => tx.type === 'adjustment' && tx.stocktake_id === result.stocktake.id);
        db.addLedger({ type: 'expense', amount: 1, transaction_id: adjustment.id });
        return result;
      }), /盘点流水.*收支方向不一致/);
      assert.deepEqual(db.backupData(), before);
    });
    await t.test('later writes cannot attach duplicate ledgers to an existing stocktake adjustment', async () => {
      const p = await product({ name: '盘点重复关联商品', stock: 5, price: 2 });
      const counted = await create('/stocktake', { product_id: p.id, counted_stock: 6 });
      const adjustment = db.listTx({ product_id: p.id }).find(tx => tx.type === 'adjustment' && tx.stocktake_id === counted.stocktake.id);
      const before = db.backupData();
      const response = await call('/ledger', 'POST', { type: 'income', amount: 2, transaction_id: adjustment.id });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.match(response.body.message, /盘点流水.*账本流水不一致/);
      assert.deepEqual(db.backupData(), before);
    });
    await t.test('void reports partial settlement amount and ledger ids', async () => {
      const p = await product({ stock: 5, price: 2 });
      const c = await create('/customers', { name: '部分结算作废客户' });
      const posted = await create('/stock/out', { product_id: p.id, quantity: 4, customer_id: c.id });
      const settled = await call(`/customers/${c.id}`, 'PUT', { debt: 6 }, `partial-settle-${++sequence}`, db.revision());
      assert.equal(settled.status, 200, JSON.stringify(settled.body));
      const settlement = db.listLedger({ include_voided: 'true' }).find(entry => entry.party_id === c.id && entry.type === 'settlement');
      assert.ok(settlement);
      const blocked = await call(`/transactions/${posted.transaction.id}`, 'DELETE');
      assert.equal(blocked.status, 400);
      assert.match(blocked.body.message, /部分结算 2 元/);
      assert.match(blocked.body.message, new RegExp(`#${settlement.id}`));
      assert.equal(db.getProduct(p.id).stock, 1);
      assert.equal(db.getCustomer(c.id).debt, 6);
    });
    await t.test('concurrent batches cannot oversell or double count receivables', async () => {
      const p = await product({ stock: 5, price: 2 });
      const c = await create('/customers', { name: '并发客户' });
      const body = { customer_id: c.id, lines: [{ product_id: p.id, quantity: 4 }] };
      const revision = db.revision();
      const r = await Promise.all([
        call('/stock/out/batch', 'POST', body, 'concurrent-stock-001', revision),
        call('/stock/out/batch', 'POST', body, 'concurrent-stock-002', revision)
      ]);
      assert.deepEqual(r.map(x => x.status).sort(), [200, 409]);
      assert.equal(db.getProduct(p.id).stock, 1);
      assert.equal(db.getCustomer(c.id).debt, 8);
      assert.equal(
        db.listLedger({ type: 'receivable' })
          .filter(entry => entry.party_id === c.id)
          .reduce((sum, entry) => sum + entry.amount, 0),
        8
      );
    });
    await t.test('delivery-note generated ledgers cannot be voided independently', async () => {
      const p = await product({ name: '送货单账本保护', stock: 0 });
      const note = await create('/delivery-notes', delivery(p));
      const freight = db.backupData().ledger.find(entry => entry.delivery_note_id === note.id);
      assert.ok(freight, 'delivery note should retain a linked freight ledger');
      const independent = await call(`/ledger/${freight.id}`, 'DELETE', undefined, `delivery-ledger-void-${++sequence}`, db.revision());
      assert.equal(independent.status, 400, JSON.stringify(independent.body));
      assert.match(independent.body.message, /送货单生成的账务请通过原单作废/);

      const tampered = db.backupData();
      const linked = tampered.ledger.find(entry => entry.id === freight.id);
      linked.voided_at = Date.now();
      const before = db.backupData();
      assert.throws(() => db.restoreData(tampered), /送货单.*运费与账本流水不一致/);
      assert.deepEqual(db.backupData(), before, 'invalid freight linkage must not replace current data');
      const voided = await call(`/delivery-notes/${note.id}`, 'DELETE', undefined, `delivery-note-void-linked-${++sequence}`, db.revision());
      assert.equal(voided.status, 200, JSON.stringify(voided.body));
      assert(db.getDeliveryNote(note.id).voided_at);
      assert(db.backupData().ledger.find(entry => entry.id === freight.id).voided_at);
    });
    await t.test('backup restore and reopening preserve postings and void history', async () => {
      const backup = (await call('/backup')).body.data.data;
      await product({ name: '备份后新增' }); await create('/backup', { data: backup });
      const after = db.backupData();
      for (const field of ['products', 'transactions', 'ledger', 'delivery_notes']) assert.deepEqual(after[field], backup[field]);
      delete require.cache[require.resolve('./db')]; const reopened = require('./db'); assert.deepEqual(reopened.backupData().transactions, backup.transactions);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
