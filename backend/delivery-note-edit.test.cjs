const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const install = require('./team');
const { localDate } = require('./stock-math');

test('carton receipts can be edited atomically and deleted with stock and accounting rollback', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-note-edit-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(dir, 'backups');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], ledger: []
  }));

  const db = require('./db');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', install(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  let sequence = 0;

  async function call(url, method = 'GET', body, key = `delivery-note-edit-${++sequence}`, revision = db.revision()) {
    const response = await fetch(origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'If-Match': String(revision) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  }

  async function create(url, body) {
    const result = await call(url, 'POST', body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.data;
  }

  try {
    const supplier = await create('/suppliers', { name: '纸箱供货商' });
    const product = await create('/products', {
      name: '采购纸箱', category: '纸箱', specification: '40×30×20', material: 'BC', unit: '个', stock: 10, price: 3
    });
    const date = localDate();
    const originalBody = {
      source_type: 'carton_purchase', billing_mode: 'on_outbound', party_type: 'supplier',
      supplier_id: supplier.id, customer_id: null, customer_name: '', supplier_name: supplier.name,
      date, entered_at: `${date}T10:00`, location: 'A-01', work_order_no: 'EDIT-001', freight: 5,
      remark: '原始备注', operator: '验收员', driver_phone: '', vehicle_no: '',
      lines: [{ product_id: product.id, product_name: product.name, specification: product.specification, material: product.material, unit: product.unit, quantity: 5, delivered_qty: 4, unit_price: 3 }]
    };
    const note = await create('/delivery-notes', originalBody);
    assert.equal(db.getProduct(product.id).stock, 14);
    assert.equal(db.getSupplier(supplier.id).payable, 12);

    await t.test('edit keeps the receipt number, replaces its current lines and keeps one freight row', async () => {
      const editedBody = {
        ...originalBody, entered_at: `${date}T11:30`, location: 'B-02', freight: 8,
        remark: '修改后的备注', operator: '复核员',
        lines: [{ ...originalBody.lines[0], quantity: 7, delivered_qty: 6, unit_price: 2 }]
      };
      const result = await call(`/delivery-notes/${note.id}`, 'PUT', editedBody);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const edited = result.body.data;
      assert.equal(edited.id, note.id);
      assert.equal(edited.created_at, note.created_at);
      assert.equal(edited.edit_count, 1);
      assert.equal(edited.entered_at, `${date}T11:30`);
      assert.equal(edited.location, 'B-02');
      assert.equal(edited.freight, 8);
      assert.equal(edited.total_amount, 12);
      assert.equal(edited.lines[0].delivered_qty, 6);
      assert.notEqual(edited.lines[0].transaction_id, note.lines[0].transaction_id);
      assert.equal(db.getProduct(product.id).stock, 16);
      assert.equal(db.getSupplier(supplier.id).payable, 12);
      assert.equal(db.backupData().transactions.find(row => row.id === edited.lines[0].transaction_id).delivery_note_id, note.id);

      const data = db.backupData();
      const freightRows = data.ledger.filter(entry => Number(entry.delivery_note_id) === note.id && entry.transaction_id == null);
      assert.equal(freightRows.length, 1);
      assert.equal(freightRows[0].amount, 8);
      assert.equal(freightRows[0].voided_at, undefined);
      assert.doesNotThrow(() => db.validateBackup(data));
      assert.equal(db.getDeliveryNote(note.id).id, note.id);
    });

    await t.test('rejected edits and retries never duplicate stock or accounting', async () => {
      const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
      const invalid = await call(`/delivery-notes/${note.id}`, 'PUT', {
        ...originalBody, lines: [{ ...originalBody.lines[0], product_id: 999999 }]
      });
      assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
      assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);

      const revision = db.revision();
      const key = 'delivery-note-edit-idempotent-key';
      const payload = {
        ...originalBody, freight: 8, remark: '修改后的备注',
        lines: [{ ...originalBody.lines[0], quantity: 7, delivered_qty: 6, unit_price: 2 }]
      };
      const first = await call(`/delivery-notes/${note.id}`, 'PUT', payload, key, revision);
      const replay = await call(`/delivery-notes/${note.id}`, 'PUT', payload, key, revision);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.deepEqual(replay.body.data, first.body.data);
      assert.equal(db.getProduct(product.id).stock, 16);
      assert.equal(db.getSupplier(supplier.id).payable, 12);
    });

    await t.test('delete reverses the current receipt and retains its deleted history', async () => {
      const result = await call(`/delivery-notes/${note.id}`, 'DELETE');
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(result.body.data.voided_at);
      assert.equal(db.getProduct(product.id).stock, 10);
      assert.equal(db.getSupplier(supplier.id).payable, 0);
      assert.equal(db.backupData().transactions.some(transaction => !transaction.voided_at && Number(transaction.delivery_note_id) === note.id), false);
      assert.equal(db.backupData().ledger.some(entry => !entry.voided_at && Number(entry.delivery_note_id) === note.id), false);
      assert.doesNotThrow(() => db.validateBackup(db.backupData()));
    });

    await t.test('production receipts keep their number in stock-only edits', async () => {
      const production = await create('/delivery-notes', {
        source_type: 'production', billing_mode: 'on_outbound', party_type: null,
        supplier_id: null, customer_id: null, supplier_name: '', customer_name: '',
        date, entered_at: `${date}T12:00`, work_order_no: 'EDIT-PRODUCTION', freight: 0,
        remark: '自产原始单', operator: '生产员', driver_phone: '', vehicle_no: '',
        lines: [{ ...originalBody.lines[0], quantity: 2, delivered_qty: 2, unit_price: 1 }]
      });
      const result = await call(`/delivery-notes/${production.id}`, 'PUT', {
        source_type: 'production', billing_mode: 'on_outbound', party_type: null,
        supplier_id: null, customer_id: null, supplier_name: '', customer_name: '',
        date, entered_at: `${date}T12:30`, work_order_no: 'EDIT-PRODUCTION', freight: 0,
        remark: '自产修改单', operator: '生产员', driver_phone: '', vehicle_no: '',
        lines: [{ ...originalBody.lines[0], quantity: 3, delivered_qty: 3, unit_price: 1 }]
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.data.id, production.id);
      assert.equal(db.getProduct(product.id).stock, 13);
      const transaction = db.backupData().transactions.find(row => row.id === result.body.data.lines[0].transaction_id);
      assert.match(transaction.remark, new RegExp(`送货单 #${production.id}(?:$| ·)`));
      assert.equal(db.backupData().ledger.some(entry => !entry.voided_at && entry.transaction_id === transaction.id), false);
      assert.equal((await call(`/delivery-notes/${production.id}`, 'DELETE')).status, 200);
      assert.equal(db.getProduct(product.id).stock, 10);
      assert.doesNotThrow(() => db.validateBackup(db.backupData()));
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
