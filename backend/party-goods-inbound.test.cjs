const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { localDate } = require('./stock-math');

test('editable partial party goods feed receipts without fake data, silent master creation or accounting drift', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-party-goods-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(directory, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('./db');
  const app = express(); app.use(express.json()); app.use('/api', require('./team')(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let sequence = 0;
  const call = async (url, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, {
      method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `party-goods-acceptance-${++sequence}`, 'If-Match': String(db.revision()) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, ...(await response.json()) };
  };
  const disk = () => fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
  const boardForm = { boardLength: 160, boardWidth: 110, cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B', layers: 3, orderedQty: 10, receivedQty: 9, billedArea: 15.84, unitPrice: 2.125, date: localDate() };
  let customer; let supplier;
  try {
    await t.test('name-only goods and any single business field survive creation and later editing', async () => {
      for (const route of ['/customers', '/suppliers']) {
        assert.equal((await call(route, 'POST', { name: '' })).status, 400);
        const response = await call(route, 'POST', { name: route === '/customers' ? '客户甲' : '供货商甲', specs: [{ id: 'name-only', goods: '常用箱', category: '纸箱' }] });
        assert.equal(response.status, 200, response.message);
        assert.equal(response.data.specs[0].specification, '');
        assert.equal(response.data.specs[0].material, '');
        assert.equal(response.data.specs[0].unit, '');
        assert.equal(response.data.specs[0].price, null);
        if (route === '/customers') customer = response.data; else supplier = response.data;
        const before = disk();
        assert.equal((await call(`${route}/${response.data.id}`, 'PUT', { specs: [{ id: 'empty', goods: ' ', specification: '', price: '' }] })).status, 400);
        assert.equal(disk(), before);
      }
      const oneFieldSpecs = [
        { id: 'size-only', specification: '40×30×20 cm' }, { id: 'material-only', material: '牛皮纸' },
        { id: 'unit-only', unit: '个' }, { id: 'zero-price', price: 0 }, { id: 'unknown-price', goods: '后补报价', price: '' }
      ];
      const saved = await call(`/suppliers/${supplier.id}/specs`, 'PUT', { specs: oneFieldSpecs });
      assert.equal(saved.status, 200, saved.message);
      assert.equal(saved.data.specs[3].price, 0);
      assert.equal(saved.data.specs[4].price, null);
      assert.equal((await call(`/suppliers/${supplier.id}/specs`)).data.specs.length, 5);
      assert.equal((await call(`/customers?keyword=${encodeURIComponent('常用箱')}`)).data[0].id, customer.id);
      const inbound = await call('/production-inbound/customers');
      const quote = inbound.data.find(row => row.id === customer.id).specs[0];
      assert.equal(quote.goods, '常用箱'); assert.equal(quote.specification, ''); assert.equal(quote.price, null);
    });

    await t.test('production requires explicit product creation and this receipt can complete a partial quote', async () => {
      const body = { source_type: 'production', party_type: 'customer', customer_id: customer.id, date: localDate(), lines: [{
        customer_spec_id: 'name-only', goods: '常用箱', specification: '40×30×20 cm', material: '牛皮纸', unit: '个', quantity: 3, delivered_qty: 3, unit_price: 1.235
      }] };
      const before = disk();
      const rejected = await call('/delivery-notes', 'POST', body);
      assert.equal(rejected.status, 400); assert.match(rejected.message, /创建并关联商品/); assert.equal(disk(), before);
      const receipt = await call('/delivery-notes', 'POST', { ...body, lines: [{ ...body.lines[0], create_product: true }] });
      assert.equal(receipt.status, 200, receipt.message);
      assert.equal(receipt.data.lines[0].amount, 3.71);
      assert.equal(receipt.data.lines[0].customer_spec_snapshot.material, '牛皮纸');
      assert.equal(db.getCustomer(customer.id).debt, 3.71);
      assert.equal(db.getCustomer(customer.id).specs[0].price, null, 'a receipt does not silently edit its reference quote');
      const product = db.getProduct(receipt.data.lines[0].product_id);
      assert.equal(product.stock, 3);
      const noPrice = { ...body, lines: [{ ...body.lines[0], product_id: product.id, unit_price: null }] };
      const beforeNoPrice = disk();
      const missing = await call('/delivery-notes', 'POST', noPrice);
      assert.equal(missing.status, 400); assert.match(missing.message, /填写入库单价/); assert.equal(disk(), beforeNoPrice);
      const voided = await call(`/delivery-notes/${receipt.data.id}`, 'DELETE');
      assert.equal(voided.status, 200); assert.equal(db.getCustomer(customer.id).debt, 0); assert.equal(db.getProduct(product.id).stock, 0);
    });

    await t.test('supplier reference data persists and priced purchase lines reconcile stock, amount and payable', async () => {
      const specs = [{ id: 'purchase', goods: '采购箱', category: '纸箱', price: null }, {
        id: 'board', goods: '常用纸板', category: '纸板', boardLength: 160, boardWidth: 110,
        cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B', layers: 3, unitPrice: null
      }];
      assert.equal((await call(`/suppliers/${supplier.id}`, 'PUT', { specs })).status, 200);
      assert.equal((await call(`/suppliers/${supplier.id}`)).data.specs[1].unitPrice, null);
      const product = db.addProduct({ name: '采购箱', category: '纸箱', specification: '20×10×5 cm', material: '白卡纸', unit: '个', stock: 0, price: 9 });
      const body = { supplier_id: supplier.id, lines: [{ product_id: product.id, supplier_spec_id: 'purchase', quantity: 3, delivered_qty: 2, unit_price: 1.235 }] };
      const receipt = await call('/delivery-notes', 'POST', body);
      assert.equal(receipt.status, 200, receipt.message);
      assert.equal(receipt.data.total_amount, 2.47); assert.equal(db.getSupplier(supplier.id).payable, 2.47); assert.equal(db.getProduct(product.id).stock, 2);
      const before = disk();
      assert.equal((await call('/delivery-notes', 'POST', { ...body, lines: [{ ...body.lines[0], unit_price: null }] })).status, 400);
      assert.equal(disk(), before);
      const unlinked = await call('/delivery-notes', 'POST', { party_type: null, supplier_id: null, lines: [{ product_id: product.id, quantity: 1, unit_price: 5 }] });
      assert.equal(unlinked.status, 200, unlinked.message); assert.equal(db.getSupplier(supplier.id).payable, 2.47);
    });

    await t.test('unlinked paperboards never create suppliers; a batch posts every line atomically', async () => {
      const supplierCount = db.listSuppliers().length;
      const ledgerCount = db.listLedger().length;
      const unlinked = await call('/boards', 'POST', { ...boardForm, supplier: '', supplier_id: null });
      assert.equal(unlinked.status, 200, unlinked.message); assert.equal(unlinked.data.supplier_id, null);
      assert.equal(db.listSuppliers().length, supplierCount); assert.equal(db.listLedger().length, ledgerCount);
      const before = disk();
      assert.equal((await call('/boards/batch', 'POST', { supplier_id: supplier.id, items: [boardForm, { ...boardForm, unitPrice: null }] })).status, 400);
      assert.equal(disk(), before);
      const batch = await call('/boards/batch', 'POST', { supplier_id: supplier.id, items: [{ ...boardForm, supplier_spec_id: 'board', freight: 3 }, { ...boardForm, receivedQty: 8, unitPrice: 1.255 }] });
      assert.equal(batch.status, 200, batch.message); assert.equal(batch.data.batches.length, 2);
      assert.equal(batch.data.total_amount, 53.54); assert.equal(db.getSupplier(supplier.id).payable, 56.01);
      assert.equal(db.listLedger().find(row => row.id === batch.data.batches[0].freight_ledger_id).amount, 3);
      assert.doesNotThrow(() => db.validateBackup(db.backupData()));
      const corruptSnapshot = db.backupData();
      corruptSnapshot.board_batches.find(row => row.id === batch.data.batches[0].id).supplier_spec_snapshot.id = 'wrong-reference';
      assert.throws(() => db.validateBackup(corruptSnapshot), /规格快照/);
      db.restoreData(db.backupData());
      assert.equal(db.getSupplier(supplier.id).specs[1].unitPrice, null);
      db.deleteBoard(batch.data.batches[0].id); db.deleteBoard(batch.data.batches[1].id);
      assert.equal(db.getSupplier(supplier.id).payable, 2.47);
      assert.doesNotThrow(() => db.validateBackup(db.backupData()));
    });

    await t.test('paperboard quotes supply specifications and price while business values remain current', async () => {
      const specs = db.getSupplier(supplier.id).specs.map(spec => spec.id === 'board' ? { ...spec, unitPrice: 2.125 } : spec);
      assert.equal((await call(`/suppliers/${supplier.id}/specs`, 'PUT', { specs })).status, 200);
      const current = { supplier_id: supplier.id, supplier_spec_id: ' board ', orderedQty: 12, receivedQty: 11, billedArea: 19.36, date: localDate(), freight: 4 };
      const noQuantity = { ...current }; delete noQuantity.receivedQty;
      const before = disk();
      assert.equal((await call('/boards', 'POST', noQuantity)).status, 400);
      assert.equal(disk(), before);
      const received = await call('/boards', 'POST', current);
      assert.equal(received.status, 200, received.message);
      assert.equal(received.data.boardLength, 160); assert.equal(received.data.unitPrice, 2.125);
      assert.equal(received.data.receivedQty, 11); assert.equal(received.data.shortageQty, 1);
      assert.equal(received.data.freight, 4); assert.equal(received.data.supplier_spec_id, 'board');
      const edited = await call(`/boards/${received.data.id}`, 'PUT', { ...boardForm, supplier_id: null, supplier_spec_id: '' });
      assert.equal(edited.status, 200, edited.message);
      assert.equal(edited.data.supplier_id, null); assert.equal(edited.data.supplier_spec_id, undefined);
      assert.equal(edited.data.supplier_spec_snapshot, undefined);
      assert.equal(db.getSupplier(supplier.id).payable, 2.47);
      assert.doesNotThrow(() => db.validateBackup(db.backupData()));
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
