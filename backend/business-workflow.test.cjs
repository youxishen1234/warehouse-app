const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
test('business workbench shares dimensions and completes production atomically', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-sync-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(dir, 'backups');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('./db');
  const app = express(); app.use(express.json()); app.use('/api', require('./team')(db));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  let seq = 0;
  const call = async (url, method = 'GET', body, key = 'business-sync-test-' + ++seq, revision = db.revision()) => {
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/api' + url, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'If-Match': String(revision), 'X-Warehouse-Device': 'business-test' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, ...await r.json() };
  };
  const form = { supplier: '学习用板厂', boardLength: 160, boardWidth: 110, cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B', layers: 3, orderedQty: 100, receivedQty: 100, billedArea: 176, unitPrice: 1, date: '2026-10-01' };
  try {
    let batch, record;
    await t.test('paperboard receipt records payable once, separately from customer receivables', async () => {
      batch = (await call('/boards', 'POST', form, 'board-payable-replay-001')).data;
      assert.equal(db.listSuppliers()[0].payable, 176);
      assert.equal(db.listLedger()[0].board_batch_id, batch.id);
      await call('/boards', 'POST', form, 'board-payable-replay-001', 0);
      assert.equal(db.listBoards().length, 1); assert.equal(db.listSuppliers()[0].payable, 176);
      assert.equal(db.listCustomers().length, 0);
      assert.throws(() => db.deleteLedger(batch.ledger_id), /原单/);
    });
    await t.test('shared spec read returns both board and carton sizes and normalizes mm', async () => {
      const product = db.addProduct({ name: '旧纸箱', category: '纸箱', specification: '400×300×200 mm', stock: 0, unit: '个' });
      const dimensions = db.getCustomerDimensions(); dimensions.customers.push({ id: 'c', name: '学习用客户', specs: [{ id: 's', goods: '小箱', size: '400×300×200', sizeUnit: 'mm', material: '', unit: '个', kind: '成品' }] }); db.updateCustomerDimensions(dimensions);
      const response = await call('/business-specifications');
      assert.equal(response.status, 200);
      assert.deepEqual(response.data.find(s => s.source === 'board').board, [160, 110]);
      assert.deepEqual(response.data.find(s => s.source === 'board').carton, [40, 30, 20]);
      assert.deepEqual(response.data.find(s => s.source_id === String(product.id) && s.source === 'product').carton, [40, 30, 20]);
      assert.deepEqual(response.data.find(s => s.source === 'customer').carton, [40, 30, 20]);
    });
    await t.test('failed or mismatched production leaves stock, bills and disk unchanged', async () => {
      const wrong = db.addProduct({ name: '错尺寸', specification: '41×30×20 cm', stock: 0, unit: '个' });
      for (const extra of [{ consumed_quantity: 101 }, { quantity: 0 }, { product_id: wrong.id }, { consumed_quantity: '10' }]) {
        const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
        const r = await call('/production', 'POST', { batch_id: batch.id, product_name: '学习用纸箱', consumed_quantity: 10, quantity: 8, ...extra });
        assert.equal(r.status, 400, r.message); assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
      }
    });
    await t.test('completion consumes actual boards, adds cartons, keeps a snapshot and replays once', async () => {
      const body = { batch_id: batch.id, product_name: '学习用纸箱', consumed_quantity: 10, quantity: 8, remark: '损耗2张' };
      const r = await call('/production', 'POST', body, 'production-replay-test-001'); assert.equal(r.status, 200, r.message); record = r.data;
      assert.equal(db.listBoards()[0].remainingQty, 90); assert.equal(db.getProduct(record.product_id).stock, 8);
      assert.equal(db.listSuppliers()[0].payable, 176); assert.equal(db.listLedger().length, 1);
      assert.deepEqual(record.specification_snapshot.carton, [40, 30, 20]);
      await call('/production', 'POST', body, 'production-replay-test-001', 0);
      assert.equal(db.listProduction().length, 1); assert.equal(db.getProduct(record.product_id).stock, 8);
      assert.throws(() => db.deleteTransaction(record.transaction_id), /不能单独作废/);
      db.updateProduct(record.product_id, { specification: '42×32×22 cm' });
      assert.deepEqual(db.listProduction()[0].specification_snapshot.carton, [40, 30, 20]);
      assert.equal((await call('/production', 'POST', body, undefined, 0)).status, 409);
    });
    await t.test('backup validation preserves the linked production and rejects damaged quantities', () => {
      const backup = db.backupData(); db.restoreData(backup);
      const corrupt = structuredClone(db.backupData()); corrupt.production_records[0].quantity++;
      assert.throws(() => db.restoreData(corrupt), /生产/);
      const before = JSON.stringify(db.backupData());
      assert.throws(() => db.transact({ id: 'test', username: 'test' }, 'forced-rollback-test-001', 'fp', String(db.revision()), 'rollback', () => { db.completeProduction({ batch_id: batch.id, product_name: '回滚测试', consumed_quantity: 1, quantity: 1 }, 'test'); throw new Error('forced failure'); }), /forced failure/);
      assert.equal(JSON.stringify(db.backupData()), before);
    });
    await t.test('paperboard edit/delete reverse their own payable without crossing party types', () => {
      const b = db.receiveBoard({ ...form, supplier: '另一个板厂' });
      const supplier = db.getSupplier(b.supplier_id);
      db.updateBoard(b.id, { ...form, supplier: supplier.name, billedArea: 100 });
      assert.equal(db.getSupplier(supplier.id).payable, 100);
      db.deleteBoard(b.id); assert.equal(db.getSupplier(supplier.id).payable, 0);
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
