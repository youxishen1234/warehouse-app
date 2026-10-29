const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { localDate } = require('./stock-math');

test('new receipt fields persist with ownership, supplier payable, reversal and portable backup', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-receipt-fields-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(folder, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(folder, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(folder, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('./db');
  const supplier = db.addSupplier({ name: '采购测试供货商' });
  const customer = db.addCustomer({ name: '归属测试客户', specs: [{ id: 'carton', goods: '客户定制箱', specification: '30×20×10', material: '牛卡', unit: '个', price: 9 }] });
  const date = localDate();
  const draft = {
    source_type: 'carton_purchase', billing_mode: 'on_outbound', party_type: 'supplier',
    supplier_id: supplier.id, customer_id: customer.id, date, entered_at: date + 'T08:35', location: '成品二库',
    lines: [{ customer_spec_id: 'carton', create_product: true, quantity: 10, delivered_qty: 10, unit_price: 2 }]
  };
  const note = db.addDeliveryNote(draft);
  const product = db.getProduct(note.lines[0].product_id);
  assert.equal(product.customer_id, customer.id);
  assert.equal(product.stock, 10);
  assert.equal(db.getSupplier(supplier.id).payable, 20);
  assert.equal(db.getCustomer(customer.id).debt, 0);
  assert.equal(db.getCustomer(customer.id).specs[0].price, 9);
  const tx = db.backupData().transactions.find(row => row.id === note.lines[0].transaction_id);
  assert.equal(tx.supplier_id, supplier.id);
  assert.equal(tx.entered_at, date + 'T08:35');
  assert.equal(tx.location, '成品二库');
  assert.equal(typeof tx.created_at, 'number');
  const backup = db.backupData();
  db.restoreData(backup);
  assert.equal(db.getDeliveryNote(note.id).location, '成品二库');
  for (const patch of [{ entered_at: date + 'T25:00' }, { location: '库位\u0001' }, { supplier_id: null }]) {
    const before = JSON.stringify(db.backupData());
    assert.throws(() => db.addDeliveryNote({ ...draft, ...patch }));
    assert.equal(JSON.stringify(db.backupData()), before);
  }
  const corrupt = db.backupData();
  corrupt.transactions.find(row => row.id === tx.id).location = '被改动';
  assert.throws(() => db.restoreData(corrupt), /库位/);
  db.voidDeliveryNote(note.id);
  assert.equal(db.getProduct(product.id).stock, 0);
  assert.equal(db.getSupplier(supplier.id).payable, 0);
  assert.equal(db.getCustomer(customer.id).debt, 0);
  db.restoreData(db.backupData());

  const boardDraft = { name: '定制五层纸板', enteredAt: date + 'T09:45', supplier_id: supplier.id, supplier: supplier.name,
    boardLength: 100, boardWidth: 80, cartonLength: 30, cartonWidth: 20, cartonHeight: 10,
    fluteType: 'BC', layers: 5, orderedQty: 10, receivedQty: 10, billedArea: 8, unitPrice: 2, date,
    save_supplier_spec: true, location: '原料二库' };
  const board = db.receiveBoard(boardDraft);
  assert.equal(board.name, boardDraft.name);
  assert.equal(board.enteredAt, boardDraft.enteredAt);
  assert.equal(db.getSupplier(supplier.id).specs.length, 1);
  db.receiveBoard(boardDraft);
  assert.equal(db.getSupplier(supplier.id).specs.length, 1, 'reusing a common specification does not append duplicates');
  db.restoreData(db.backupData());
  assert.equal(db.listBoards().find(row => row.id === board.id).enteredAt, boardDraft.enteredAt);
  const before = JSON.stringify(db.backupData());
  assert.throws(() => db.receiveBoard({ ...boardDraft, enteredAt: 'invalid' }));
  assert.equal(JSON.stringify(db.backupData()), before);
  const legacy = db.backupData();
  for (const row of legacy.board_batches) { delete row.name; delete row.enteredAt; }
  for (const row of legacy.delivery_notes) { delete row.entered_at; delete row.location; }
  for (const row of legacy.transactions) { delete row.entered_at; delete row.location; }
  db.restoreData(legacy);
});
