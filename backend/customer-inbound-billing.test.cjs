const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('customer production receipts are billed once, settle correctly and preserve source accounting', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-customer-inbound-contract-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('./db');
  let sequence = 0;
  const customer = (name = '生产客户', specs) => {
    const row = db.addCustomer({ name: `${name}-${++sequence}` });
    return specs ? db.updateCustomer(row.id, { specs }) : row;
  };
  const product = (extra = {}) => db.addProduct({ name: `纸箱-${++sequence}`, category: '纸箱', specification: '30×20×15 cm', material: '牛皮纸', unit: '个', price: 9, stock: 0, ...extra });
  const receipt = (party, goods, quantity, price, extra = {}) => db.addDeliveryNote({
    source_type: 'production', party_type: party ? 'customer' : null,
    customer_id: party?.id ?? null, supplier_id: null,
    work_order_no: `BILLING-CONTRACT-${++sequence}`,
    lines: [{ product_id: goods.id, quantity, delivered_qty: quantity, unit_price: price, specification: goods.specification }],
    ...extra
  });
  const unchangedOnThrow = (operation, expression) => {
    const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
    assert.throws(operation, expression);
    assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before, 'rejected mutations must not change persisted data');
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  try {
    await t.test('300+200 becomes 500 debt and two bills; settlement100 leaves400; shipping is not charged again', () => {
      const c = customer(); const p = product();
      const first = receipt(c, p, 100, 3);
      const second = receipt(c, p, 100, 2);
      assert.equal(db.getCustomer(c.id).debt, 500);
      assert.equal(db.listDeliveryNotes().filter(row => row.customer_id === c.id && !row.voided_at).reduce((sum, row) => sum + row.total_amount, 0), 500);
      const bills = db.listLedger().filter(row => row.party_id === c.id && row.type === 'receivable');
      assert.deepEqual(bills.map(row => row.amount).sort((a, b) => a - b), [200, 300]);
      assert.deepEqual(bills.map(row => row.delivery_note_id).sort((a, b) => a - b), [first.id, second.id]);
      assert.equal(db.getProduct(p.id).price, 9);
      db.settleParty('customer', c.id, 100, '实收100');
      const settlement = db.listLedger().find(row => row.type === 'settlement' && row.party_id === c.id);
      assert.equal(db.getCustomer(c.id).debt, 400);
      const shipped = db.stockOut(p.id, 200, '', '', c.id, { specification: p.specification, unit_price: 2.5 }).transaction;
      assert.equal(shipped.amount, 500, 'full shipment value remains visible');
      assert.equal(shipped.receivable_amount, 0, 'none of the billed cartons is invoiced twice');
      assert.deepEqual(shipped.billed_inbound_allocations.map(row => row.quantity), [100, 100]);
      assert.equal(db.getCustomer(c.id).debt, 400);
      assert.equal(db.listLedger().filter(row => row.transaction_id === shipped.id).length, 0);
      receipt(null, p, 200, 0); // Enough pooled stock must not bypass the source-allocation lock.
      unchangedOnThrow(() => db.voidDeliveryNote(first.id), /出库|抵扣|分配|关联/);
      assert.doesNotThrow(() => db.validateBackup(db.backupData()));
      db.deleteTransaction(shipped.id);
      assert.equal(db.getCustomer(c.id).debt, 400, 'voiding a prepaid shipment does not undo the original invoice');
      db.voidDeliveryNote(second.id);
      assert.equal(db.getCustomer(c.id).debt, 200);
      unchangedOnThrow(() => db.voidDeliveryNote(first.id), /结算|收款|余额/);
      db.deleteLedger(settlement.id);
      assert.equal(db.getCustomer(c.id).debt, 300);
      db.voidDeliveryNote(first.id);
      assert.equal(db.getCustomer(c.id).debt, 0);
      assert.doesNotThrow(() => db.validateBackup(db.backupData()));
    });

    await t.test('partial coverage charges only uncovered quantity; other customers cannot use the credit', () => {
      const a = customer('部分覆盖'); const b = customer('其他客户'); const p = product();
      const source = receipt(a, p, 5, 3);
      receipt(null, p, 5, 0);
      const shipped = db.stockOut(p.id, 8, '', '', a.id, { specification: '300×200×150 mm', unit_price: 4 }).transaction;
      assert.equal(shipped.amount, 32); assert.equal(shipped.receivable_amount, 12);
      assert.deepEqual(shipped.billed_inbound_allocations, [{ transaction_id: source.lines[0].transaction_id, quantity: 5 }]);
      assert.equal(db.getCustomer(a.id).debt, 27);
      assert.equal(db.listLedger().find(row => row.transaction_id === shipped.id).amount, 12);
      unchangedOnThrow(() => db.updateTransaction(shipped.id, { quantity: 7 }), /作废|抵扣|分配/);
      db.deleteTransaction(shipped.id);
      assert.equal(db.getCustomer(a.id).debt, 15);
      const otherShipment = db.stockOut(p.id, 2, '', '', b.id, { unit_price: 4 }).transaction;
      assert.equal(otherShipment.receivable_amount, 8);
      assert.deepEqual(otherShipment.billed_inbound_allocations, []);
      assert.equal(db.getCustomer(b.id).debt, 8);
      const replacement = db.stockOut(p.id, 5, '', '', a.id, { unit_price: 4 }).transaction;
      assert.equal(replacement.receivable_amount, 0, 'voided allocation is available to a replacement shipment');
      assert.equal(db.getCustomer(a.id).debt, 15);
      assert.doesNotThrow(() => db.validateBackup(db.backupData()));
    });

    await t.test('customer quotation is authoritative, including zero, and old receipt prices stay immutable', () => {
      const spec = { id: 'quote-a', goods: '客户规格纸箱', specification: '30×20×15 cm', material: '牛皮纸', unit: '个', price: 3 };
      const c = customer('报价', [spec]); const p = product();
      const body = { lines: [{ product_id: p.id, quantity: 2, delivered_qty: 2, customer_spec_id: spec.id, specification: p.specification, unit_price: 3 }] };
      const first = receipt(c, p, 2, 3, body);
      assert.equal(first.total_amount, 6); assert.equal(first.lines[0].customer_spec_id, spec.id);
      assert.equal(first.lines[0].customer_spec_snapshot.price, 3);
      db.updateCustomer(c.id, { specs: [{ ...spec, price: 0 }] });
      unchangedOnThrow(() => receipt(c, p, 2, 3, body), /单价.*更新|刷新/);
      const zero = receipt(c, p, 2, 0, { lines: [{ ...body.lines[0], unit_price: 0 }] });
      assert.equal(zero.total_amount, 0);
      assert.equal(db.getDeliveryNote(first.id).total_amount, 6);
      const shipped = db.stockOut(p.id, 4, '', '', c.id, { unit_price: 10 }).transaction;
      assert.equal(shipped.receivable_amount, 0, 'zero-valued billed receipts still cover their quantity');
      assert.equal(db.getCustomer(c.id).debt, 6);
      const other = customer('错误规格客户');
      unchangedOnThrow(() => receipt(other, p, 1, 0, { lines: [{ ...body.lines[0], unit_price: 0 }] }), /客户规格|报价/);
      assert.doesNotThrow(() => db.validateBackup(db.backupData()));
    });

    await t.test('backup rejects over-allocation, wrong-customer and altered receivable amounts without rewriting live data', () => {
      const c = customer('备份'); const p = product();
      receipt(c, p, 10, 3);
      const shipped = db.stockOut(p.id, 4, '', '', c.id, { unit_price: 8 }).transaction;
      const valid = db.backupData();
      const badQuantity = copy(valid);
      badQuantity.transactions.find(row => row.id === shipped.id).billed_inbound_allocations[0].quantity = 11;
      assert.throws(() => db.validateBackup(badQuantity));
      const wrongCustomer = copy(valid);
      wrongCustomer.transactions.find(row => row.id === shipped.id).billed_inbound_allocations[0].transaction_id = valid.transactions.find(row => row.billing_source === 'production_inbound' && row.customer_id !== c.id).id;
      assert.throws(() => db.validateBackup(wrongCustomer));
      const altered = copy(valid);
      altered.transactions.find(row => row.id === shipped.id).receivable_amount = 1;
      assert.throws(() => db.validateBackup(altered));
      const missingAllocation = copy(valid);
      delete missingAllocation.transactions.find(row => row.id === shipped.id).billed_inbound_allocations;
      assert.throws(() => db.validateBackup(missingAllocation), /抵扣|应收/);
      const wrongReceivableType = copy(valid);
      wrongReceivableType.transactions.find(row => row.id === shipped.billed_inbound_allocations[0].transaction_id).billing_source = undefined;
      assert.throws(() => db.validateBackup(wrongReceivableType));
      const markerForgery = copy(valid);
      const source = markerForgery.transactions.find(row => row.id === shipped.billed_inbound_allocations[0].transaction_id);
      source.billing_source = undefined;
      assert.throws(() => db.validateBackup(markerForgery));
      const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
      assert.throws(() => db.restoreData(altered));
      assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
      assert.doesNotThrow(() => db.restoreData(valid));
      assert.equal(db.getCustomer(c.id).debt, 30);
      assert.doesNotThrow(() => db.validateBackup(db.backupData()));
    });
  } finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
