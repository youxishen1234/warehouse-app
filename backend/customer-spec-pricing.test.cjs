const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');

const fileHash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

test('customer quote edits persist metadata without rewriting accounting or receipt price snapshots', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-customer-spec-pricing-'));
  const dataFile = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_DATA_FILE = dataFile;
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('./db');
  const app = express();
  app.use(express.json());
  app.use('/api', require('./team')(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (url, options = {}) => {
    const response = await fetch(origin + url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  try {
    const product = db.addProduct({
      name: '客户报价纸箱', category: '纸箱', specification: '30×20×15 cm',
      material: '牛皮纸', unit: '个', price: 9, stock: 10
    });
    const customer = db.addCustomer({ name: '规格报价客户', debt: 25 });
    const quote = {
      id: 'quote-precise', goods: '客户报价纸箱', specification: '30×20×15 cm',
      material: '牛皮纸', unit: '个', price: 1.234567, kind: '成品',
      dimension_source: { customer_id: 'dimension:a:b', spec_id: 'spec:c' }
    };
    db.updateCustomer(customer.id, { specs: [quote] });
    assert.deepEqual(db.getCustomer(customer.id).specs, [quote], 'quote metadata must round-trip exactly');

    const receipt = db.addDeliveryNote({
      source_type: 'production', party_type: 'customer', customer_id: customer.id, supplier_id: null,
      work_order_no: 'SPEC-PRICE-SNAPSHOT', date: '2026-10-27',
      lines: [{
        product_id: product.id, quantity: 2, delivered_qty: 2, unit_price: 1.234567,
        specification: product.specification, customer_spec_id: quote.id,
        customer_spec_snapshot: { ...quote }
      }]
    });
    const debtBefore = db.getCustomer(customer.id).debt;
    const ledgerBefore = JSON.stringify(db.listLedger());
    const productBefore = JSON.stringify(db.getProduct(product.id));
    const receiptBefore = JSON.stringify(db.getDeliveryNote(receipt.id));

    await t.test('editing a quote changes only Customer.specs', () => {
      db.updateCustomer(customer.id, { specs: [{ ...quote, price: 0 }] });
      assert.equal(db.getCustomer(customer.id).specs[0].price, 0);
      assert.equal(db.getCustomer(customer.id).debt, debtBefore, 'quote edit must not change receivables');
      assert.equal(JSON.stringify(db.listLedger()), ledgerBefore, 'quote edit must not append ledger entries');
      assert.equal(JSON.stringify(db.getProduct(product.id)), productBefore, 'quote edit must not change inventory price or stock');
      assert.equal(JSON.stringify(db.getDeliveryNote(receipt.id)), receiptBefore, 'saved receipt prices are immutable snapshots');
    });

    await t.test('malformed and stale writes are atomic', async () => {
      let sync = await call('/sync');
      assert.equal(sync.status, 200);
      const revision = String(sync.body.data.revision);
      const beforeHash = fileHash(dataFile);
      const beforeState = JSON.stringify(db.getCustomer(customer.id));
      const invalid = await call(`/customers/${customer.id}`, {
        method: 'PUT',
        headers: { 'Idempotency-Key': 'customer-spec-invalid-0001', 'If-Match': revision },
        body: { specs: [{ ...quote, price: 'free' }, { ...quote, id: 'second', price: -1 }] }
      });
      assert.equal(invalid.status, 400);
      assert.equal(fileHash(dataFile), beforeHash, 'rejected specs must not reach disk');
      assert.equal(JSON.stringify(db.getCustomer(customer.id)), beforeState, 'rejected specs must not leak into memory');

      const duplicateSource = await call(`/customers/${customer.id}`, {
        method: 'PUT',
        headers: { 'Idempotency-Key': 'customer-spec-source-0001', 'If-Match': revision },
        body: { specs: [{ ...quote, id: 'source-a' }, { ...quote, id: 'source-b' }] }
      });
      assert.equal(duplicateSource.status, 400);
      assert.match(duplicateSource.body.message, /尺寸本规格不能重复报价/);
      assert.equal(fileHash(dataFile), beforeHash, 'duplicate dimension sources must not reach disk');
      assert.equal(JSON.stringify(db.getCustomer(customer.id)), beforeState);

      const stale = await call(`/customers/${customer.id}`, {
        method: 'PUT',
        headers: { 'Idempotency-Key': 'customer-spec-stale-0001', 'If-Match': String(Number(revision) - 1) },
        body: { specs: [{ ...quote, price: 1 }] }
      });
      assert.equal(stale.status, 409);
      assert.equal(JSON.stringify(db.getCustomer(customer.id)), beforeState, 'stale quote writes must not apply');
      sync = await call('/sync');
      assert.equal(String(sync.body.data.revision), revision, 'rejected writes must not advance the revision');
    });

    await t.test('a dimension source cannot be linked by two active customers', async () => {
      const otherCustomer = db.addCustomer({ name: '另一规格报价客户' });
      const sync = await call('/sync');
      const revision = String(sync.body.data.revision);
      const beforeHash = fileHash(dataFile);
      const duplicate = await call(`/customers/${otherCustomer.id}`, {
        method: 'PUT',
        headers: { 'Idempotency-Key': 'customer-spec-cross-owner-0001', 'If-Match': revision },
        body: { specs: [{ ...quote, id: 'other-customer-quote' }] }
      });
      assert.equal(duplicate.status, 400);
      assert.match(duplicate.body.message, /该尺寸本规格已被其他客户报价/);
      assert.equal(fileHash(dataFile), beforeHash, 'cross-customer source conflicts must not reach disk');
      assert.equal(db.getCustomer(otherCustomer.id).specs, undefined);
    });

    await t.test('the same idempotency key replays without a second state change', async () => {
      const sync = await call('/sync');
      const revision = String(sync.body.data.revision);
      const headers = { 'Idempotency-Key': 'customer-spec-retry-0001', 'If-Match': revision };
      const body = { specs: [{ ...quote, price: 7.5 }] };
      const first = await call(`/customers/${customer.id}`, { method: 'PUT', headers, body });
      assert.equal(first.status, 200);
      const afterFirst = fileHash(dataFile);
      const replayed = await call(`/customers/${customer.id}`, { method: 'PUT', headers, body });
      assert.equal(replayed.status, 200);
      assert.equal(fileHash(dataFile), afterFirst, 'replayed receipt must not write a second time');
      assert.equal(db.getCustomer(customer.id).specs[0].price, 7.5);
    });

    await t.test('portable backup and a fresh process preserve quote metadata', () => {
      const backup = db.backupData();
      assert.doesNotThrow(() => db.validateBackup(backup));
      assert.deepEqual(backup.customers.find(row => row.id === customer.id).specs, db.getCustomer(customer.id).specs);
      const restored = path.join(temporary, 'restored.json');
      fs.writeFileSync(restored, JSON.stringify(backup));
      const script = "const assert=require('node:assert/strict'),db=require('./db');const c=db.getCustomer(Number(process.env.TEST_CUSTOMER_ID));assert.equal(c.specs[0].price,7.5);assert.equal(c.specs[0].kind,'成品');assert.deepEqual(c.specs[0].dimension_source,{customer_id:'dimension:a:b',spec_id:'spec:c'});assert.equal(c.debt,Number(process.env.TEST_CUSTOMER_DEBT));process.stdout.write('reopened');";
      const output = execFileSync(process.execPath, ['-e', script], {
        cwd: __dirname,
        env: { ...process.env, WAREHOUSE_DATA_FILE: restored, TEST_CUSTOMER_ID: String(customer.id), TEST_CUSTOMER_DEBT: String(db.getCustomer(customer.id).debt) },
        encoding: 'utf8'
      });
      assert.equal(output, 'reopened');
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
