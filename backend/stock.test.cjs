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
  const app = express(); app.use(express.json()); app.use('/api', install(db));
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
    await t.test('actual receipt quantity drives stock, amount, area and payable', async () => {
      const p = await product({ length: 1200, width: 600 }); const s = await create('/suppliers', { name: '测试供应商' });
      const note = await create('/delivery-notes', delivery(p, { supplier_id: s.id, operator: '验收员' }));
      assert.equal(db.getProduct(p.id).stock, 28); assert.equal(note.total_amount, 20); assert.equal(note.total_square_meters, 5.76);
      assert.equal(db.getSupplier(s.id).payable, 20); assert.equal(note.lines[0].unit, '张');
      assert.equal(db.listTx({ product_id: p.id })[0].operator, '验收员');
      const csv = await call(`/delivery-notes/${note.id}.csv`); assert.equal(csv.status, 200); assert.match(csv.body, /实际入库/); assert.match(csv.body, /"8"/);
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
    });
    await t.test('concurrent batches cannot oversell', async () => {
      const p = await product({ stock: 5 }); const body = { lines: [{ product_id: p.id, quantity: 4 }] }; const revision = db.revision();
      const r = await Promise.all([call('/stock/out/batch', 'POST', body, 'concurrent-stock-001', revision), call('/stock/out/batch', 'POST', body, 'concurrent-stock-002', revision)]);
      assert.deepEqual(r.map(x => x.status).sort(), [200, 409]); assert.equal(db.getProduct(p.id).stock, 1);
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
