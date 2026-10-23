const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const install = require('./team');
const { localDate } = require('./stock-math');
const productionPricing = require('./production-pricing');

test('production pricing applies a trailing physical unit to every unlabelled dimension', () => {
  assert.deepEqual(productionPricing.dimensionsInCm('300×200×150 mm'), [30, 20, 15]);
  assert.deepEqual(productionPricing.dimensionsInCm('30×20×15 cm'), [30, 20, 15]);
  assert.deepEqual(productionPricing.dimensionsInCm('30mm×20cm×15mm'), [3, 20, 1.5]);
  assert.notDeepEqual(productionPricing.dimensionsInCm('30cm×20cm×15cm'), productionPricing.dimensionsInCm('30mm×20mm×15mm'));
});

test('production carton inbound calculates value without purchase accounting and remains reversible', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-production-inbound-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(dir, 'backups');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], ledger: []
  }));
  const db = require('./db');
  const app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api', install(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  let sequence = 0;
  async function call(url, method = 'GET', body, key = `production-inbound-${++sequence}`, revision = db.revision()) {
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
  async function rejectedWithoutMutation(url, body, pattern) {
    const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
    const result = await call(url, 'POST', body);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    if (pattern) assert.match(result.body.message, pattern);
    assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
  }
  try {
    const supplier = await create('/suppliers', { name: '正常采购供应商' });
    const customer = await create('/customers', { name: '客户供箱测试客户' });
    const carton = await create('/products', {
      name: '自产纸箱', category: '纸箱', specification: '40×30×20', unit: '个', stock: 1, price: 6
    });
    const productionBody = {
      source_type: 'production',
      date: localDate(),
      work_order_no: 'PROD-IN-001',
      party_type: null,
      freight: 0,
      remark: '本厂生产完工',
      total_amount: 9999,
      lines: [{ product_id: carton.id, quantity: 10, delivered_qty: 8, unit_price: 2.5, amount: 0.01 }]
    };

    await t.test('HTTP save and idempotent replay calculate delivered quantity times unit price', async () => {
      const initialRevision = db.revision();
      const key = 'production-carton-inbound-fixed-key';
      const first = await call('/delivery-notes', 'POST', productionBody, key, initialRevision);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.data.source_type, 'production');
      assert.equal(first.body.data.party_type, null);
      assert.equal(first.body.data.supplier_id, null);
      assert.equal(first.body.data.customer_id, null);
      assert.equal(first.body.data.supplier_name, '');
      assert.equal(first.body.data.customer_name, '');
      assert.equal(first.body.data.lines[0].amount, 20);
      assert.equal(first.body.data.total_amount, 20);
      assert.equal(db.getProduct(carton.id).stock, 9);
      assert.equal(db.getProduct(carton.id).price, 6, 'receipt must not rewrite the product base price');

      const replay = await call('/delivery-notes', 'POST', productionBody, key, initialRevision);
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.deepEqual(replay.body.data, first.body.data);
      assert.equal(db.getProduct(carton.id).stock, 9, 'idempotent replay must not add stock twice');
      const transaction = db.backupData().transactions.find(row => row.id === first.body.data.lines[0].transaction_id);
      assert.equal(transaction.amount, 20);
      assert.equal(transaction.unit_price, 2.5);
      assert.equal(transaction.quantity, 8);
      assert.equal(transaction.supplier_id, null);
      assert.equal(transaction.customer_id, null);
      assert.equal(transaction.supplier_name, '');
      assert.equal(transaction.customer_name, '');
      assert.match(transaction.remark, new RegExp(`自产成品入库 · 送货单 #${first.body.data.id}`));
      assert.equal(transaction.delivery_note_id, first.body.data.id);
    });

    await t.test('nonzero production value does not create cash/income/expense or AR/AP', () => {
      const snapshot = db.backupData();
      const productionNote = snapshot.delivery_notes.find(row => row.source_type === 'production');
      const txId = productionNote.lines[0].transaction_id;
      assert.equal(snapshot.ledger.some(entry => entry.transaction_id === txId), false);
      assert.equal(snapshot.ledger.some(entry => entry.delivery_note_id === productionNote.id), false);
      assert.equal(snapshot.ledger.some(entry => ['income', 'expense'].includes(entry.type)), false);
      assert.equal(db.getSupplier(supplier.id).payable, 0);
      assert.equal(db.getCustomer(customer.id).debt, 0);
      const financial = db.stats();
      assert.equal(financial.totalPayable, 0);
      assert.equal(financial.totalReceivable, 0);
    });

    await t.test('source and association errors reject atomically; paperboard is not a finished carton', async () => {
      await rejectedWithoutMutation('/delivery-notes', { ...productionBody, source_type: 'unknown', work_order_no: 'INVALID-SOURCE' }, /来源类型/);
      await rejectedWithoutMutation('/delivery-notes', { ...productionBody, party_type: 'supplier', work_order_no: 'INVALID-PARTY-TYPE' }, /不能关联往来对象/);
      await rejectedWithoutMutation('/delivery-notes', { ...productionBody, supplier_id: supplier.id, party_type: null, work_order_no: 'INVALID-SUPPLIER' }, /不能关联供应商/);
      await rejectedWithoutMutation('/delivery-notes', { ...productionBody, customer_id: customer.id, party_type: 'supplier', work_order_no: 'INVALID-CUSTOMER-PARTY-TYPE' }, /必须为客户/);
      await rejectedWithoutMutation('/delivery-notes', { ...productionBody, supplier_name: supplier.name, work_order_no: 'INVALID-SUPPLIER-NAME' }, /不能关联供应商/);
      await rejectedWithoutMutation('/delivery-notes', { ...productionBody, customer_name: customer.name, work_order_no: 'INVALID-CUSTOMER-NAME' }, /客户信息必须通过客户编号选择/);
      await rejectedWithoutMutation('/delivery-notes', {
        ...productionBody, work_order_no: 'INVALID-ZERO-DELIVERED',
        lines: [{ ...productionBody.lines[0], delivered_qty: 0 }]
      }, /实际入库数量/);
      const board = await create('/products', {
        name: '纸板不能当自产纸箱', category: '纸板', specification: '40×30×20cm', unit: '张', stock: 0, price: 0
      });
      await rejectedWithoutMutation('/delivery-notes', {
        ...productionBody, work_order_no: 'PROD-IN-BOARD', lines: [{ ...productionBody.lines[0], product_id: board.id }]
      }, /只能选择纸箱商品/);
    });

    await t.test('three-dimensional finished-goods spec is eligible and zero unit price is valid', async () => {
      const zeroCost = await create('/products', {
        name: '裸规格零估值自产纸箱', category: '成品', specification: '18×12×8', unit: '个', stock: 0, price: 0
      });
      const note = await create('/delivery-notes', {
        source_type: 'production', work_order_no: 'PROD-IN-ZERO-COST',
        lines: [{ product_id: zeroCost.id, quantity: 1, delivered_qty: 1, unit_price: 0 }]
      });
      assert.equal(note.total_amount, 0);
      assert.equal(db.getProduct(zeroCost.id).stock, 1);
      assert.equal(db.backupData().ledger.some(entry => entry.delivery_note_id === note.id), false);
      const voided = await call(`/delivery-notes/${note.id}`, 'DELETE');
      assert.equal(voided.status, 200, JSON.stringify(voided.body));
      assert.equal(db.getProduct(zeroCost.id).stock, 0);

      const flatGoods = await create('/products', {
        name: '二维非纸箱商品', category: '包材', specification: '18×12', unit: '个', stock: 0, price: 0
      });
      await rejectedWithoutMutation('/delivery-notes', {
        source_type: 'production',
        work_order_no: 'PROD-IN-2D-NON-CARTON',
        lines: [{ product_id: flatGoods.id, quantity: 1, delivered_qty: 1, unit_price: 0 }]
      }, /只能选择纸箱商品/);
    });

    await t.test('CSV labels production source, and legacy purchase retains payable behavior', async () => {
      const productionNote = db.listDeliveryNotes().find(row => row.source_type === 'production');
      const noteCsv = await call(`/delivery-notes/${productionNote.id}.csv`);
      assert.equal(noteCsv.status, 200);
      assert.match(noteCsv.body, /"入库来源","自产成品入库"/);
      assert.match(noteCsv.body, /"入库金额"/);
      assert.match(noteCsv.body, /"入库金额合计"/);
      assert.doesNotMatch(noteCsv.body, /采购单号|供应商采购/);

      const customerNote = await create('/delivery-notes', {
        source_type: 'production', customer_id: customer.id, party_type: 'customer',
        work_order_no: 'PROD-IN-CSV-CUSTOMER',
        lines: [{ product_id: carton.id, quantity: 1, delivered_qty: 1, unit_price: 1 }]
      });
      const customerCsv = await call(`/delivery-notes/${customerNote.id}.csv`);
      assert.equal(customerCsv.status, 200);
      assert.match(customerCsv.body, /"关联客户","客户供箱测试客户"/);
      assert.match(customerCsv.body, /"计价客户","客户供箱测试客户"/, 'keep the existing pricing-customer row');
      const voidCustomerNote = await call(`/delivery-notes/${customerNote.id}`, 'DELETE');
      assert.equal(voidCustomerNote.status, 200, JSON.stringify(voidCustomerNote.body));

      const boughtCarton = await create('/products', {
        name: '正常采购纸箱', category: '纸箱', specification: '30×20×15', unit: '个', stock: 0, price: 4
      });
      const oldPurchase = await create('/delivery-notes', {
        date: localDate(), supplier_id: supplier.id,
        lines: [{ product_id: boughtCarton.id, quantity: 2, delivered_qty: 2, unit_price: 3 }]
      });
      assert.equal(Object.hasOwn(oldPurchase, 'source_type'), false, 'legacy requests without source_type keep their old semantics');
      assert.equal(oldPurchase.party_type, 'supplier');
      assert.equal(oldPurchase.total_amount, 6);
      assert.equal(db.getSupplier(supplier.id).payable, 6);
      assert.equal(db.backupData().ledger.filter(entry => entry.type === 'payable').reduce((sum, entry) => sum + entry.amount, 0), 6);
    });

    await t.test('backup validation, restore and old source-less purchase data remain compatible', () => {
      const backup = db.backupData();
      assert.equal(backup.delivery_notes.find(row => row.source_type === 'production').total_amount, 20);
      assert.doesNotThrow(() => db.validateBackup(backup));
      const badParty = JSON.parse(JSON.stringify(backup));
      const production = badParty.delivery_notes.find(row => row.source_type === 'production');
      production.supplier_id = supplier.id;
      assert.throws(() => db.validateBackup(badParty), /自产成品入库单.*往来对象关联无效/);
      const badLedger = JSON.parse(JSON.stringify(backup));
      const productionTx = badLedger.transactions.find(row => row.delivery_note_id === production.id);
      badLedger.ledger.push({
        id: Math.max(0, ...badLedger.ledger.map(row => row.id)) + 1,
        type: 'payable', amount: 20, party_id: supplier.id, party_type: 'supplier',
        party_name: supplier.name, transaction_id: productionTx.id, created_at: Date.now()
      });
      assert.throws(() => db.validateBackup(badLedger), /不应关联往来账本流水/);
      const legacy = backup.delivery_notes.find(row => row.source_type === undefined);
      assert.ok(legacy);
      assert.doesNotThrow(() => db.validateBackup(backup), 'a legacy delivery note without source_type is still valid');
      assert.doesNotThrow(() => db.restoreData(backup));
      assert.equal(db.getDeliveryNote(production.id).source_type, 'production');
      assert.equal(db.getProduct(carton.id).stock, 9);
      assert.equal(db.getSupplier(supplier.id).payable, 6);

      const nonBillingInboundReceivable = JSON.parse(JSON.stringify(backup));
      const ordinaryInbound = nonBillingInboundReceivable.transactions.find(row => row.type === 'in' && row.billing_source !== 'production_inbound');
      assert.ok(ordinaryInbound);
      ordinaryInbound.receivable_amount = 0;
      assert.throws(() => db.validateBackup(nonBillingInboundReceivable), /非出库或自产入库交易不能设置应收金额/);
    });

    await t.test('unparsed carton specs match by normalized text while physical units remain distinct', async () => {
      const smallCustomer = await create('/customers', { name: '小号纸箱客户' });
      const small = await create('/products', {
        name: '小号纸箱', category: '纸箱', specification: '小号', unit: '个', stock: 0, price: 1
      });
      const smallNote = await create('/delivery-notes', {
        source_type: 'production', customer_id: smallCustomer.id, party_type: 'customer',
        work_order_no: 'PROD-IN-SMALL',
        lines: [{ product_id: small.id, quantity: 4, delivered_qty: 4, unit_price: 5 }]
      });
      const smallInbound = db.backupData().transactions.find(row => row.id === smallNote.lines[0].transaction_id);
      const smallLedger = db.backupData().ledger.find(row => row.transaction_id === smallInbound.id);
      assert.equal(smallCustomer ? db.getCustomer(smallCustomer.id).debt : 0, 20);
      assert.equal(smallLedger.delivery_note_id, smallNote.id);
      const smallOut = db.stockOut(small.id, 2, '规格匹配测试', '', smallCustomer.id, { unit: '个', unit_price: 5, specification: ' 小号 ' }).transaction;
      assert.equal(smallOut.receivable_amount, 0);
      assert.deepEqual(smallOut.billed_inbound_allocations, [{ transaction_id: smallInbound.id, quantity: 2 }]);
      assert.equal(db.getCustomer(smallCustomer.id).debt, 20);

      const unallocatedReducedReceivable = db.backupData();
      const unallocatedOutput = unallocatedReducedReceivable.transactions.find(row => row.id === smallOut.id);
      assert.ok(unallocatedOutput);
      delete unallocatedOutput.billed_inbound_allocations;
      unallocatedOutput.receivable_amount = 0;
      assert.throws(() => db.validateBackup(unallocatedReducedReceivable), /无自产入库抵扣明细时，应收金额必须等于交易金额/);

      const noSpecCustomer = await create('/customers', { name: '无规格纸箱客户' });
      const noSpec = await create('/products', { name: '无规格纸箱', category: '纸箱', specification: '', unit: '个', stock: 0, price: 1 });
      const noSpecNote = await create('/delivery-notes', {
        source_type: 'production', customer_id: noSpecCustomer.id, party_type: 'customer', work_order_no: 'PROD-IN-NO-SPEC',
        lines: [{ product_id: noSpec.id, quantity: 2, delivered_qty: 2, unit_price: 4 }]
      });
      const noSpecInbound = db.backupData().transactions.find(row => row.id === noSpecNote.lines[0].transaction_id);
      const noSpecOut = db.stockOut(noSpec.id, 1, '空规格匹配测试', '', noSpecCustomer.id, { unit: '个', unit_price: 4 }).transaction;
      assert.equal(noSpecOut.receivable_amount, 0, 'same product and unit with identical empty specs should not rebill');
      assert.deepEqual(noSpecOut.billed_inbound_allocations, [{ transaction_id: noSpecInbound.id, quantity: 1 }]);
      assert.equal(db.getCustomer(noSpecCustomer.id).debt, 8);

      const dimensionsCustomer = await create('/customers', { name: '尺寸单位客户' });
      const dimensionsProduct = await create('/products', {
        name: '厘米规格纸箱', category: '纸箱', specification: '30cm×20cm×15cm', unit: '个', stock: 0, price: 1
      });
      const dimensionsNote = await create('/delivery-notes', {
        source_type: 'production', customer_id: dimensionsCustomer.id, party_type: 'customer',
        work_order_no: 'PROD-IN-CM',
        lines: [{ product_id: dimensionsProduct.id, quantity: 3, delivered_qty: 3, unit_price: 2 }]
      });
      const dimensionsInbound = db.backupData().transactions.find(row => row.id === dimensionsNote.lines[0].transaction_id);
      const equivalentOut = db.stockOut(dimensionsProduct.id, 1, '等值尺寸测试', '', dimensionsCustomer.id, {
        unit: '个', unit_price: 2, specification: '300mm×200mm×150mm'
      }).transaction;
      assert.equal(equivalentOut.receivable_amount, 0, 'cm and equivalent mm dimensions should match physically');
      const differentOut = db.stockOut(dimensionsProduct.id, 1, '异值尺寸测试', '', dimensionsCustomer.id, {
        unit: '个', unit_price: 2, specification: '30mm×20mm×15mm'
      }).transaction;
      assert.equal(differentOut.receivable_amount, 2, '30 cm must not be treated as 30 mm');
      assert.deepEqual(differentOut.billed_inbound_allocations, []);
      assert.equal(db.getCustomer(dimensionsCustomer.id).debt, 8);
      assert.equal(dimensionsInbound.billing_source, 'production_inbound');
    });

    await t.test('voiding the production note reverses only stock and creates no payable', async () => {
      const note = db.listDeliveryNotes().find(row => row.source_type === 'production' && !row.voided_at && row.lines.some(line => line.product_id === carton.id));
      const beforeLedger = db.backupData().ledger.length;
      const response = await call(`/delivery-notes/${note.id}`, 'DELETE');
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.ok(response.body.data.voided_at);
      assert.equal(db.getProduct(carton.id).stock, 1);
      assert.equal(db.getSupplier(supplier.id).payable, 6, 'voiding production does not reverse or create purchase payable');
      assert.equal(db.getCustomer(customer.id).debt, 0);
      assert.equal(db.backupData().ledger.length, beforeLedger);
      const voided = db.backupData().transactions.find(row => row.delivery_note_id === note.id);
      assert.ok(voided.voided_at);
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
