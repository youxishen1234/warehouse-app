const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('orderToOutbound reuses batch stock and is atomic', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-order-outbound-')), 'data.json');
  process.env.WAREHOUSE_DATA_FILE = file;
  fs.writeFileSync(file, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: [] }));
  delete require.cache[require.resolve('./db')];
  const db = require('./db');
  const customer = db.addCustomer({ name: 'outbound customer' });
  const product = db.addProduct({ name: 'outbound product', stock: 5, price: 2 });
  const order = db.addOrder({ order_no: 'ORDER-OUTBOUND-1', customer_id: customer.id, quantity: 2, unit_price: 2, status: '生产中' });
  const result = db.orderToOutbound(order.id, [{ product_id: product.id, quantity: 2, unit_price: 2 }], 'tester');
  assert.equal(result.transactions.length, 1);
  assert.equal(db.getProduct(product.id).stock, 3);
  assert.equal(db.listOrders()[0].status, '已发货');
  const before = JSON.stringify(db.backupData());
  assert.throws(() => db.orderToOutbound(order.id, [{ product_id: product.id, quantity: 99 }]), /库存不足/);
  assert.equal(JSON.stringify(db.backupData()), before);
});
