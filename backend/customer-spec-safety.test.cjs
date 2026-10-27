const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { empty } = require('./customer-dimensions');
const { localDate } = require('./stock-math');
const productionPricing = require('./production-pricing');

test('customer-owned carton isolation, backup invariants and atomic spec saves', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-customer-spec-safety-'));
  const dataFile = path.join(directory, 'data.json');
  const dimensionsFile = path.join(directory, 'dimensions.json');
  process.env.WAREHOUSE_DATA_FILE = dataFile;
  process.env.WAREHOUSE_BACKUP_DIR = path.join(directory, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = dimensionsFile;
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], ledger: [],
    orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  fs.writeFileSync(dimensionsFile, JSON.stringify({
    ...empty(),
    revision: 6,
    customers: [
      { id: 'legacy-account', name: 'Legacy Buyer', specs: [
        { id: 'legacy-size', goods: '旧规格纸箱', size: '25×15×10', sizeUnit: 'cm', material: '牛皮纸', unit: '个', kind: '成品' }
      ] },
      { id: 'account-dims', name: 'Account Buyer', specs: [
        { id: 'delete-me', goods: '待删规格', size: '10×8×6', sizeUnit: 'cm', material: '白卡纸', unit: '个', kind: '成品' },
        { id: 'keep-me', goods: '保留规格', size: '12×9×7', sizeUnit: 'cm', material: '白卡纸', unit: '个', kind: '成品' }
      ] }
    ]
  }));

  const db = require('./db');
  const team = require('./team');
  let activeRole = 'operator';
  let sequence = 0;
  const app = express();
  app.use(express.json());
  app.use('/api', team(db, { actorFor: () => ({ id: 'spec-safety-test', username: '规格测试', role: activeRole }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `customer-spec-safety-${++sequence}-${crypto.randomUUID()}`,
        'If-Match': String(db.revision()),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, revision: response.headers.get('x-warehouse-revision'), ...(await response.json()) };
  };
  const disk = () => fs.readFileSync(dataFile, 'utf8');
  const clone = value => JSON.parse(JSON.stringify(value));

  try {
    await t.test('owner isolation covers stock, orders, transactions, delivery notes and print notes', async () => {
      const owner = db.addCustomer({ name: '专属客户' });
      const other = db.addCustomer({ name: '其他客户' });
      const supplier = db.addSupplier({ name: '供货商' });
      const owned = db.addProduct({ name: '专属纸箱', category: '纸箱', specification: '30×20×15 cm', material: '牛皮纸', unit: '个', stock: 20, price: 2 });
      owned.customer_id = owner.id;
      owned.customer_name = owner.name;
      db.updateCustomer(owner.id, { remark: 'persist owner' });
      const legacy = db.addProduct({ name: '历史无归属纸箱', category: '纸箱', specification: '18×12×8 cm', material: '瓦楞纸', unit: '个', stock: 20, price: 1 });

      for (const request of [
        call('/stock/out', 'POST', { product_id: owned.id, quantity: 1, customer_id: other.id }),
        call('/stock/in', 'POST', { product_id: owned.id, quantity: 1, supplier_id: supplier.id }),
        call('/stock/out/batch', 'POST', { customer_id: other.id, lines: [{ product_id: owned.id, quantity: 1 }] })
      ]) {
        const response = await request;
        assert.equal(response.status, 400);
        assert.match(response.message, /专属|属于|其他客户/);
      }
      assert.equal(db.getProduct(owned.id).stock, 20);

      const order = db.addOrder({ order_no: 'OWNER-ORDER-1', customer_id: other.id, quantity: 1, unit: '个', unit_price: 2, status: '待发货' });
      const orderShip = await call(`/orders/${order.id}/outbound`, 'POST', { product_id: owned.id, quantity: 1 });
      assert.equal(orderShip.status, 400);

      const receipt = db.stockOut(owned.id, 1, 'owner', '', owner.id, { unit_price: 2 });
      const edit = await call(`/transactions/${receipt.transaction.id}`, 'PUT', { customer_id: other.id });
      assert.equal(edit.status, 400);
      assert.equal(db.getCustomer(owner.id).debt, 2);
      assert.equal(db.getCustomer(other.id).debt, 0);

      const supplierNote = await call('/delivery-notes', 'POST', {
        date: localDate(), supplier_id: supplier.id, work_order_no: 'OWNER-SUPPLIER-IN',
        lines: [{ product_id: owned.id, quantity: 1, delivered_qty: 1, unit_price: 2 }]
      });
      assert.equal(supplierNote.status, 400);

      const printNote = await call('/print-notes', 'POST', {
        company: '测试公司', customer_id: other.id, customer_name: other.name, address: '', phone: '', receiver: '', sender: '',
        date: localDate(), paper: '241-93',
        items: [{ product_id: owned.id, name: owned.name, specification: owned.specification, quantity: 1, price: 2, remark: '' }]
      });
      assert.equal(printNote.status, 400);

      const legacyShip = await call('/stock/out', 'POST', { product_id: legacy.id, quantity: 1, customer_id: other.id });
      assert.equal(legacyShip.status, 200);
      assert.equal(db.getProduct(legacy.id).stock, 19);
    });

    await t.test('print notes retain customer-spec identity and reject unsafe fallback', async () => {
      const owner = db.addCustomer({ name: 'Print Owner', specs: [{
        id: 'print-spec', goods: 'Print Carton', specification: '22x14x9 cm', material: 'white', unit: '\u4e2a', price: 2
      }] });
      const other = db.addCustomer({ name: 'Print Other' });
      const product = db.addProduct({
        name: 'Print Carton', category: 'carton', specification: '22x14x9 cm', material: 'white', unit: '\u4e2a', stock: 5, price: 2
      });
      product.customer_id = owner.id;
      product.customer_name = owner.name;
      db.updateCustomer(owner.id, { remark: 'persist print owner' });
      const note = await call('/print-notes', 'POST', {
        company: 'Print Test', customer_id: owner.id, customer_name: owner.name,
        address: '', phone: '', receiver: '', sender: '', date: localDate(), paper: '241-93',
        items: [{
          product_id: product.id, customer_spec_id: 'print-spec',
          customer_spec_snapshot: {
            id: 'print-spec', goods: 'Print Carton', specification: '22x14x9 cm', material: 'white', unit: '\u4e2a', price: 2
          },
          name: 'Print Carton', specification: '22x14x9 cm', quantity: 1, price: 2, remark: ''
        }]
      });
      assert.equal(note.status, 200, JSON.stringify(note));
      assert.equal(note.data.items[0].customer_spec_id, 'print-spec');
      assert.equal(note.data.items[0].customer_spec_snapshot.material, 'white');
      assert.equal(note.data.items[0].product_customer_id, owner.id);

      const backup = db.backupData();
      assert.doesNotThrow(() => db.validateBackup(backup));
      const crossOwner = clone(backup);
      crossOwner.print_notes.find(row => row.id === note.data.id).customer_id = other.id;
      assert.throws(() => db.validateBackup(crossOwner), /归属|其他客户/);
      const forgedSnapshot = clone(backup);
      forgedSnapshot.print_notes.find(row => row.id === note.data.id).items[0].customer_spec_snapshot.goods = 'Forged Carton';
      assert.throws(() => db.validateBackup(forgedSnapshot), /客户规格快照/);

      db.restoreData(backup);
      const restored = db.listPrintNotes().find(row => row.id === note.data.id);
      assert.equal(restored.items[0].customer_spec_id, 'print-spec');
      assert.equal(restored.items[0].product_customer_id, owner.id);
      db.deleteProduct(product.id);
      const beforeShip = db.backupData();
      const explicitDeleted = await call(`/print-notes/${note.data.id}/ship`, 'POST', {});
      assert.equal(explicitDeleted.status, 400);
      assert.match(explicitDeleted.message, /已停用|不存在/);
      assert.deepEqual(db.backupData().transactions, beforeShip.transactions);
      assert.deepEqual(db.backupData().products, beforeShip.products);
    });

    await t.test('explicit customer products reuse or reject; one unambiguous legacy SKU is claimed and price alias works', async () => {
      const customer = db.addCustomer({ name: 'Legacy Buyer', specs: [] });
      const spec = db.listCartonInboundCustomers().find(row => row.id === customer.id).specs
        .find(row => row.id === productionPricing.dimensionSpecId('legacy-account', 'legacy-size'));
      assert.ok(spec);
      const legacyProduct = db.addProduct({ name: spec.goods, category: '纸箱', specification: `${spec.specification}`, material: spec.material, unit: spec.unit, stock: 0, price: 0 });
      const productCount = db.listProducts().length;
      const body = {
        source_type: 'production', party_type: 'customer', customer_id: customer.id, work_order_no: 'SPEC-CLAIM-1',
        lines: [{ product_id: legacyProduct.id, customer_spec_id: spec.id, quantity: 2, delivered_qty: 2, specification: spec.specification, price: 2.5 }]
      };
      const claimed = await call('/delivery-notes', 'POST', body);
      assert.equal(claimed.status, 200, JSON.stringify(claimed));
      assert.equal(claimed.data.lines[0].product_id, legacyProduct.id);
      assert.equal(claimed.data.lines[0].customer_spec_snapshot.price, 2.5);
      assert.equal(db.getProduct(legacyProduct.id).customer_id, customer.id);
      assert.equal(db.listProducts().length, productCount, 'claim must not create a duplicate SKU');

      const reused = await call('/delivery-notes', 'POST', {
        ...body, work_order_no: 'SPEC-CLAIM-2',
        lines: [{ ...body.lines[0], unit_price: 2.5, price: undefined }]
      });
      assert.equal(reused.status, 200);
      assert.equal(reused.data.lines[0].product_id, legacyProduct.id);
      db.updateProduct(legacyProduct.id, { name: '商品后来改名', specification: '28×18×12 cm', material: '后来材质' });

      const foreignCustomer = db.addCustomer({ name: 'Foreign Owner' });
      const foreignProduct = db.addProduct({ name: spec.goods, category: '纸箱', specification: spec.specification, material: spec.material, unit: spec.unit, stock: 0, price: 0 });
      foreignProduct.customer_id = foreignCustomer.id;
      foreignProduct.customer_name = foreignCustomer.name;
      db.updateCustomer(foreignCustomer.id, { remark: 'persist foreign owner' });
      const beforeForeign = disk();
      const foreign = await call('/delivery-notes', 'POST', {
        ...body, work_order_no: 'SPEC-FOREIGN',
        lines: [{ ...body.lines[0], product_id: foreignProduct.id }]
      });
      assert.equal(foreign.status, 400);
      assert.match(foreign.message, /其他客户|归属/);
      assert.equal(disk(), beforeForeign);

      const ambiguousCustomer = db.addCustomer({ name: 'Ambiguous Buyer', specs: [{
        id: 'ambiguous-spec', goods: '歧义纸箱', specification: '20×10×5 cm', material: '白卡纸', unit: '个', price: 1
      }] });
      db.addProduct({ name: '歧义纸箱', category: '纸箱', specification: '20×10×5 cm', material: '白卡纸', unit: '个', stock: 0, price: 0 });
      db.addProduct({ name: '歧义纸箱', category: '纸箱', specification: '20×10×5 cm', material: '白卡纸', unit: '个', stock: 0, price: 0 });
      const ambiguousSpec = db.listCartonInboundCustomers().find(row => row.id === ambiguousCustomer.id).specs[0];
      const beforeAmbiguous = disk();
      const ambiguous = await call('/delivery-notes', 'POST', {
        source_type: 'production', party_type: 'customer', customer_id: ambiguousCustomer.id, work_order_no: 'SPEC-AMBIGUOUS',
        lines: [{ product_id: null, customer_spec_id: ambiguousSpec.id, quantity: 1, delivered_qty: 1, unit_price: 1 }]
      });
      assert.equal(ambiguous.status, 400);
      assert.match(ambiguous.message, /不唯一|核对/);
      assert.equal(disk(), beforeAmbiguous);

      const historyCustomer = db.addCustomer({ name: 'History Buyer', specs: [{
        id: 'history-spec', goods: 'History carton', specification: '21x13x9 cm', material: 'white', unit: 'piece', price: 1
      }] });
      const historyOther = db.addCustomer({ name: 'History Other' });
      const historyProduct = db.addProduct({
        name: 'History carton', category: 'carton', specification: '21x13x9 cm', material: 'white', unit: 'piece', stock: 3, price: 1
      });
      db.stockOut(historyProduct.id, 1, 'legacy history', '', historyOther.id, { unit_price: 1 });
      const beforeHistoryClaim = disk();
      const historyClaim = await call('/delivery-notes', 'POST', {
        source_type: 'production', party_type: 'customer', customer_id: historyCustomer.id, work_order_no: 'SPEC-HISTORY-CONFLICT',
        lines: [{ product_id: historyProduct.id, customer_spec_id: 'history-spec', quantity: 1, delivered_qty: 1, specification: '21x13x9 cm', unit_price: 1 }]
      });
      assert.equal(historyClaim.status, 400);
      assert.match(historyClaim.message, /历史商品.*共享/);
      assert.equal(db.getProduct(historyProduct.id).customer_id, undefined);
      assert.equal(disk(), beforeHistoryClaim);
    });

    await t.test('PUT customer specs updates profile and deletes dimension specs in one revision', async () => {
      const customer = db.addCustomer({ name: 'Account Buyer', specs: [{
        id: 'account-old', goods: '旧账户规格', specification: '14×10×8 cm', material: '白卡纸', unit: '个', price: 3
      }] });
      const current = db.listCartonInboundCustomers().find(row => row.id === customer.id);
      const removeId = productionPricing.dimensionSpecId('account-dims', 'delete-me');
      assert.ok(current.specs.some(spec => spec.id === removeId));
      const beforeRevision = db.revision();
      const dimensionRevision = db.getCustomerDimensions().revision;
      const payload = {
        profile: { name: 'Account Buyer', contact: '联系人', phone: '13800000000', address: '地址', remark: '原子保存' },
        specs: [{ id: 'account-new', goods: '新账户规格', specification: '16×11×9 cm', material: '白卡纸', unit: '个', price: 5 }],
        dimension_revision: dimensionRevision,
        expected_specs: current.specs,
        removed_dimension_spec_ids: [removeId]
      };
      const saved = await call(`/customers/${customer.id}/specs`, 'PUT', payload);
      assert.equal(saved.status, 200, JSON.stringify(saved));
      assert.equal(saved.data.id, customer.id);
      assert.equal(saved.data.contact, '联系人');
      assert.deepEqual(saved.data.specs.map(spec => spec.id), ['account-new']);
      assert.equal(db.revision(), beforeRevision + 1);
      assert.equal(db.getCustomerDimensions().revision, dimensionRevision + 1);
      assert.equal(db.getCustomerDimensions().customers.find(row => row.id === 'account-dims').specs.some(spec => spec.id === 'delete-me'), false);

      const stale = await call(`/customers/${customer.id}/specs`, 'PUT', payload);
      assert.equal(stale.status, 409);
      assert.equal(db.getCustomer(customer.id).contact, '联系人');

      const fresh = db.listCartonInboundCustomers().find(row => row.id === customer.id);
      const staleSnapshot = await call(`/customers/${customer.id}/specs`, 'PUT', {
        profile: { name: 'Account Buyer', contact: '不应采用' }, specs: [], dimension_revision: db.getCustomerDimensions().revision,
        expected_specs: fresh.specs.slice(1), removed_dimension_spec_ids: []
      });
      assert.equal(staleSnapshot.status, 409);
      assert.equal(db.getCustomer(customer.id).contact, '联系人');

      activeRole = 'viewer';
      const viewer = await call(`/customers/${customer.id}/specs`, 'PUT', {
        profile: { name: '不能保存' }, specs: [], dimension_revision: db.getCustomerDimensions().revision,
        expected_specs: fresh.specs, removed_dimension_spec_ids: []
      });
      assert.equal(viewer.status, 403);
      activeRole = 'operator';

      const beforeFailed = db.backupData();
      const beforeDisk = disk();
      const keepId = productionPricing.dimensionSpecId('account-dims', 'keep-me');
      const rename = fs.renameSync;
      fs.renameSync = (source, target) => {
        if (target === dataFile) throw new Error('simulated persistence failure');
        return rename(source, target);
      };
      let failed;
      try {
        failed = await call(`/customers/${customer.id}/specs`, 'PUT', {
          profile: { name: 'Account Buyer', contact: '不应落盘' }, specs: [], dimension_revision: db.getCustomerDimensions().revision,
          expected_specs: fresh.specs, removed_dimension_spec_ids: [keepId]
        });
      } finally {
        fs.renameSync = rename;
      }
      assert.equal(failed.status, 500);
      assert.equal(disk(), beforeDisk);
      assert.deepEqual(db.backupData(), beforeFailed);
    });

    await t.test('backup restore rejects ownership, snapshot, duplicate-id and negative-price corruption but loads legacy gaps', () => {
      const valid = db.backupData();
      assert.doesNotThrow(() => db.validateBackup(valid));

      const migrated = clone(valid);
      const evidenceLine = migrated.delivery_notes.flatMap(note => note.lines.map(line => ({ note, line })))
        .find(row => row.line.customer_spec_snapshot && row.note.customer_id != null);
      assert.ok(evidenceLine);
      const migratedProduct = migrated.products.find(product => product.id === evidenceLine.line.product_id);
      delete migratedProduct.customer_id;
      delete migratedProduct.customer_name;
      assert.doesNotThrow(() => db.restoreData(migrated));
      assert.equal(db.getProduct(migratedProduct.id).customer_id, evidenceLine.note.customer_id);

      const conflictingMigration = clone(valid);
      const conflictingProduct = conflictingMigration.products.find(product => product.id === evidenceLine.line.product_id);
      delete conflictingProduct.customer_id;
      delete conflictingProduct.customer_name;
      const conflictingTransaction = conflictingMigration.transactions.find(transaction => transaction.product_id === conflictingProduct.id && transaction.type !== 'adjustment');
      assert.ok(conflictingTransaction);
      conflictingTransaction.customer_id = conflictingMigration.customers.find(customer => customer.id !== evidenceLine.note.customer_id).id;
      assert.throws(() => db.validateBackup(conflictingMigration), /归属|规格|账本|不一致/);

      const missingOwner = clone(valid);
      missingOwner.products.find(product => product.customer_id != null).customer_id = 99999999;
      assert.throws(() => db.restoreData(missingOwner), /商品.*归属/);

      const wrongSnapshot = clone(valid);
      const specLine = wrongSnapshot.delivery_notes.flatMap(note => note.lines).find(line => line.customer_spec_snapshot);
      assert.ok(specLine);
      specLine.customer_spec_snapshot.goods = '伪造货物';
      assert.throws(() => db.validateBackup(wrongSnapshot), /客户规格快照/);

      const wrongOwner = clone(valid);
      const snapshotNote = wrongOwner.delivery_notes.find(note => note.lines.some(line => line.customer_spec_snapshot));
      const snapshotProduct = wrongOwner.products.find(product => product.id === snapshotNote.lines.find(line => line.customer_spec_snapshot).product_id);
      snapshotProduct.customer_id = wrongOwner.customers.find(customer => customer.id !== snapshotNote.customer_id).id;
      assert.throws(() => db.validateBackup(wrongOwner), /专属|属于|其他客户/);

      const duplicateIds = clone(valid);
      const duplicateCustomer = duplicateIds.customers.find(customer => Array.isArray(customer.specs) && customer.specs.length);
      duplicateCustomer.specs.push({ ...duplicateCustomer.specs[0] });
      assert.throws(() => db.validateBackup(duplicateIds), /规格编号重复/);

      const negativePrice = clone(valid);
      const pricedCustomer = negativePrice.customers.find(customer => Array.isArray(customer.specs) && customer.specs.length);
      pricedCustomer.specs[0].price = -0.01;
      assert.throws(() => db.validateBackup(negativePrice), /单价无效/);

      const nonFinitePrice = clone(valid);
      const nonFiniteCustomer = nonFinitePrice.customers.find(customer => Array.isArray(customer.specs) && customer.specs.length);
      nonFiniteCustomer.specs[0].price = Infinity;
      assert.throws(() => db.validateBackup(nonFinitePrice), /单价无效/);

      const before = disk();
      assert.throws(() => db.restoreData(negativePrice), /单价无效/);
      assert.equal(disk(), before);

      const legacy = clone(valid);
      for (const product of legacy.products) delete product.customer_id;
      for (const customer of legacy.customers) delete customer.specs;
      delete legacy.orders;
      delete legacy.order_events;
      delete legacy.stocktakes;
      delete legacy.delivery_notes;
      legacy.transactions = [];
      legacy.ledger = [];
      delete legacy.print_notes;
      delete legacy.products[0].price;
      delete legacy.customers[0].debt;
      if (legacy.suppliers[0]) delete legacy.suppliers[0].payable;
      assert.doesNotThrow(() => db.validateBackup(legacy));
      assert.doesNotThrow(() => db.restoreData(legacy));
      assert.equal(db.getProduct(legacy.products[0].id).price, 0);
      assert.equal(db.getCustomer(legacy.customers[0].id).debt, 0);
      if (legacy.suppliers[0]) assert.equal(db.getSupplier(legacy.suppliers[0].id).payable, 0);
      assert.deepEqual(db.listOrders(), []);
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./team')];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
