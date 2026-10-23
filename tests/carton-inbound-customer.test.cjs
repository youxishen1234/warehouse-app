const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { localDate } = require('../backend/stock-math');

test('carton inbound associates a customer without creating a customer receivable and preserves supplier history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-carton-customer-'));
  const dataFile = path.join(dir, 'data.json');
  process.env.WAREHOUSE_DATA_FILE = dataFile;
  process.env.WAREHOUSE_BACKUP_DIR = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [], delivery_notes: [] }));

  try {
    const db = require('../backend/db');
    const customer = db.addCustomer({ name: '客户提供纸箱' });
    const boardSupplier = db.addSupplier({ name: '纸板采购供货商' });
    const historySupplier = db.addSupplier({ name: '历史纸箱供货商' });
    const carton = db.addProduct({ name: '客户纸箱规格', category: '纸箱', specification: '30×20×15 cm', unit: '个', price: 2.5, stock: 10 });
    const legacyProduct = db.addProduct({ name: '历史采购纸箱', category: '纸箱', specification: '40×30×20 cm', unit: '个', price: 3, stock: 0 });

    const legacyNote = db.addDeliveryNote({
      date: localDate(), work_order_no: 'LEGACY-SUPPLIER-001', supplier_id: historySupplier.id,
      lines: [{ product_id: legacyProduct.id, quantity: 2, delivered_qty: 2, unit_price: 3 }]
    });
    assert.equal(legacyNote.supplier_id, historySupplier.id);
    assert.equal(db.getSupplier(historySupplier.id).payable, 6);

    db.receiveBoard({
      supplier: boardSupplier.name, boardLength: 100, boardWidth: 70,
      cartonLength: 30, cartonWidth: 20, cartonHeight: 15,
      fluteType: 'B', layers: 3, orderedQty: 10, receivedQty: 10,
      billedArea: 20, unitPrice: 1.5, date: localDate(), deliveryNo: 'BOARD-BASELINE-001'
    });
    const boardPayableBeforeCarton = db.getSupplier(boardSupplier.id).payable;
    const customerDebtBeforeCarton = db.getCustomer(customer.id).debt;
    const cartonStockBefore = db.getProduct(carton.id).stock;

    const customerNote = db.addDeliveryNote({
      date: localDate(), work_order_no: 'CUSTOMER-CARTON-001', customer_id: customer.id,
      lines: [{ product_id: carton.id, quantity: 4, delivered_qty: 4, unit_price: 2.5 }]
    });

    assert.equal(customerNote.customer_id, customer.id, '新纸箱入库单应记录客户编号');
    assert.equal(customerNote.customer_name, customer.name, '新纸箱入库单应保存客户名称快照');
    assert.equal(customerNote.supplier_id ?? null, null, '客户提供的纸箱入库不应误记为供货商采购');
    assert.equal(customerNote.supplier_name ?? '', '', '客户单据不应显示供货商名称');
    assert.equal(db.getProduct(carton.id).stock, cartonStockBefore + 4, '客户提供纸箱入库仍应增加库存');
    assert.equal(db.getCustomer(customer.id).debt, customerDebtBeforeCarton, '客户提供纸箱入库不应增加客户应收');
    assert.equal(db.getSupplier(boardSupplier.id).payable, boardPayableBeforeCarton, '纸箱客户入库不能改变纸板供货商应付');
    assert.equal(db.getSupplier(historySupplier.id).payable, 6, '历史供货商入库的应付保持原样');

    const listedLegacy = db.listDeliveryNotes().find(note => note.id === legacyNote.id);
    assert.equal(listedLegacy.supplier_id, historySupplier.id, '历史供货商入库单仍可从列表读取');
    assert.equal(db.getDeliveryNote(legacyNote.id).supplier_name, historySupplier.name, '历史供货商名称快照仍可读取');

    db.restoreData(db.backupData());
    assert.equal(db.getDeliveryNote(legacyNote.id).supplier_id, historySupplier.id, '备份恢复后仍兼容旧供货商入库单');
    assert.equal(db.getDeliveryNote(customerNote.id).customer_id, customer.id, '备份恢复后保留新客户归属');
  } finally {
    delete require.cache[require.resolve('../backend/db')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
