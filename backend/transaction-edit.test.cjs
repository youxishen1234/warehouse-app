const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const install = require('./team');

test('posted stock movements can be edited and deleted atomically', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-tx-edit-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('./db');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', install(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  let sequence = 0;
  async function call(url, method = 'GET', body) {
    const response = await fetch(origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `tx-edit-20261021-${++sequence}`, 'If-Match': String(db.revision()) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(raw) : raw };
  }
  try {
    const supplier = (await call('/suppliers', 'POST', { name: '纸板供应商' })).body.data;
    const customer = (await call('/customers', 'POST', { name: '纸箱客户' })).body.data;
    const product = (await call('/products', 'POST', { name: '三层纸板', specification: '900×600', unit: '张', price: 2, stock: 10 })).body.data;

    await t.test('inbound edit adjusts stock, payable and the same ledger row', async () => {
      const inbound = await call('/stock/in', 'POST', { product_id: product.id, quantity: 5, unit_price: 2, supplier_id: supplier.id });
      assert.equal(inbound.status, 200, JSON.stringify(inbound.body));
      const txId = inbound.body.data.transaction.id;
      assert.equal(db.getProduct(product.id).stock, 15);
      assert.equal(db.getSupplier(supplier.id).payable, 10);
      let ledger = db.listLedger({}).filter(entry => entry.transaction_id === txId);
      assert.equal(ledger.length, 1);
      const ledgerId = ledger[0].id;

      const edited = await call(`/transactions/${txId}`, 'PUT', { quantity: 8, unit_price: 3 });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(db.getProduct(product.id).stock, 18);
      assert.equal(db.getSupplier(supplier.id).payable, 24);
      assert.equal(edited.body.data.transaction.amount, 24);
      assert.equal(edited.body.data.transaction.edit_count, 1);
      ledger = db.listLedger({ include_voided: 'true' }).filter(entry => entry.transaction_id === txId);
      assert.equal(ledger.length, 1, 'editing must not append a second ledger row');
      assert.equal(ledger[0].id, ledgerId);
      assert.equal(ledger[0].amount, 24);
      assert.equal(ledger[0].voided_at, undefined);
    });

    let inboundId = db.listTx({ type: 'in' })[0].id;
    await t.test('removing and restoring the supplier keeps the balance and ledger in step', async () => {
      let edited = await call(`/transactions/${inboundId}`, 'PUT', { supplier_id: null });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(db.getSupplier(supplier.id).payable, 0);
      assert.equal(edited.body.data.transaction.supplier_name, '');
      let ledger = db.listLedger({ include_voided: 'true' }).filter(entry => entry.transaction_id === inboundId);
      assert.equal(ledger.length, 1);
      assert.ok(ledger[0].voided_at, 'unlinked payable must be voided, not left active');

      edited = await call(`/transactions/${inboundId}`, 'PUT', { supplier_id: supplier.id });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(db.getSupplier(supplier.id).payable, 24);
      ledger = db.listLedger({ include_voided: 'true' }).filter(entry => entry.transaction_id === inboundId);
      assert.equal(ledger.filter(entry => !entry.voided_at).length, 1);
    });

    let outboundId = null;
    await t.test('outbound edit adjusts stock and receivable; overdraw is rejected without writing', async () => {
      const outbound = await call('/stock/out', 'POST', { product_id: product.id, quantity: 3, unit_price: 2, customer_id: customer.id });
      assert.equal(outbound.status, 200, JSON.stringify(outbound.body));
      outboundId = outbound.body.data.transaction.id;
      assert.equal(db.getProduct(product.id).stock, 15);

      const edited = await call(`/transactions/${outboundId}`, 'PUT', { quantity: 5 });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(db.getProduct(product.id).stock, 13);
      assert.equal(db.getCustomer(customer.id).debt, 10);

      const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
      const rejected = await call(`/transactions/${outboundId}`, 'PUT', { quantity: 99 });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.match(rejected.body.message, /库存不足/);
      assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
    });

    await t.test('deleting an outbound reverses stock and receivable', async () => {
      const deleted = await call(`/transactions/${outboundId}`, 'DELETE');
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      assert.equal(db.getProduct(product.id).stock, 18);
      assert.equal(db.getCustomer(customer.id).debt, 0);
    });

    await t.test('delivery-note lines stay under their own workflow', async () => {
      const note = (await call('/delivery-notes', 'POST', {
        date: '2026-10-21',
        lines: [{ product_id: product.id, quantity: 2, delivered_qty: 2, unit_price: 2 }]
      })).body.data;
      const rejected = await call(`/transactions/${note.lines[0].transaction_id}`, 'PUT', { quantity: 1 });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.match(rejected.body.message, /送货单/);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
