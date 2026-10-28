const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('new carton receipts record cost and bill the customer on actual outbound', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-outbound-cost-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(directory, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('./db');
  const customer = db.addCustomer({ name: '隔离成本客户' });
  const product = db.addProduct({ name: '成本纸箱', category: '纸箱', specification: '30×20×15 cm', material: '牛卡', unit: '个', stock: 0, price: 5 });
  const note = db.addDeliveryNote({
    source_type: 'production', billing_mode: 'on_outbound', party_type: 'customer', customer_id: customer.id,
    lines: [{ product_id: product.id, quantity: 100, delivered_qty: 100, unit_price: 2 }]
  });
  assert.equal(note.total_amount, 200);
  assert.equal(db.getCustomer(customer.id).debt, 0);
  assert.equal(db.getProduct(product.id).stock, 100);
  assert.equal(db.getProduct(product.id).price, 5);
  db.stockOut(product.id, 30, '测试', '', customer.id, { unit_price: 5 });
  assert.equal(db.getCustomer(customer.id).debt, 150);
  assert.equal(db.getProduct(product.id).stock, 70);
  const saved = JSON.parse(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'));
  db.validateBackup(saved);
  assert.equal(saved.transactions.find(row => row.type === 'in').billing_source, undefined);
  assert.equal(saved.ledger.filter(row => row.type === 'receivable').length, 1);
});
