const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function openDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-produce-to-stock-'));
  const file = path.join(root, 'data.json');
  process.env.WAREHOUSE_DATA_FILE = file;
  process.env.WAREHOUSE_BACKUP_DIR = path.join(root, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(root, 'customer-dimensions.json');
  fs.writeFileSync(file, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], ledger: [],
    orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  delete require.cache[require.resolve('./db')];
  const db = require('./db');
  t.after(() => {
    delete require.cache[require.resolve('./db')];
    fs.rmSync(root, { recursive: true, force: true });
  });
  return db;
}

test('produce cartons into stock, create a ready-stock order, ship it and reverse it without double posting', t => {
  const db = openDatabase(t);
  const date = require('./stock-math').localDate();
  const board = db.receiveBoard({
    supplier: '自产流程纸板供应商',
    date,
    boardLength: 160,
    boardWidth: 110,
    cartonLength: 40,
    cartonWidth: 30,
    cartonHeight: 20,
    fluteType: 'B',
    layers: 3,
    orderedQty: 10,
    receivedQty: 10,
    billedArea: 100,
    unitPrice: 2
  });
  const supplier = db.listSuppliers().find(row => row.name === '自产流程纸板供应商');
  assert.equal(supplier.payable, 200);
  assert.equal(db.listLedger().filter(row => row.party_id === supplier.id && row.type === 'payable').reduce((sum, row) => sum + row.amount, 0), 200);

  // This factory production happens before the customer/order exists.
  const production = db.completeProduction({
    batch_id: board.id,
    product_name: '自产库存纸箱',
    consumed_quantity: 6,
    quantity: 10
  }, '测试操作员');
  const product = db.getProduct(production.product_id);
  assert.equal(db.listBoards().find(row => row.id === board.id).remainingQty, 4);
  assert.equal(product.stock, 10);
  assert.equal(db.listCustomers().length, 0);
  assert.equal(db.listSuppliers().find(row => row.id === supplier.id).payable, 200);

  const customer = db.addCustomer({ name: '自产流程客户' });
  assert.equal(customer.debt, 0);
  const defaultOrder = db.addOrder({ order_no: 'DEFAULT-STATUS', customer_id: customer.id, quantity: 1 });
  assert.equal(defaultOrder.status, '待生产', 'legacy API callers retain the existing default');
  db.updateOrder(defaultOrder.id, { status: '待发货' });
  assert.equal(db.listOrderEvents(defaultOrder.id)[0].from, '待生产');
  const transitioningLegacy = db.addOrder({
    order_no: 'LEGACY-READY-TRANSITION',
    customer_id: customer.id,
    quantity: 1,
    unit: '个',
    status: '生产中'
  });
  db.updateOrder(transitioningLegacy.id, { status: '待发货' });
  assert.equal(db.listOrderEvents(transitioningLegacy.id)[0].to, '待发货');
  const order = db.addOrder({
    order_no: 'READY-STOCK-001',
    customer_id: customer.id,
    specification: product.specification,
    quantity: 6,
    unit: '个',
    unit_price: 12.5,
    status: '待发货'
  });
  assert.equal(db.getProduct(product.id).stock, 10, 'placing an order does not move finished-goods stock');
  assert.equal(db.getCustomer(customer.id).debt, 0, 'placing an order does not bill before shipment');
  db.validateBackup(db.backupData());

  const partial = db.orderToOutbound(order.id, [{
    product_id: product.id, quantity: 2, unit_price: order.unit_price, unit: '个'
  }], '测试操作员');
  assert.equal(partial.order.status, '待发货');
  assert.equal(db.getProduct(product.id).stock, 8);
  assert.equal(db.getCustomer(customer.id).debt, 25);
  assert.equal(partial.transactions[0].transaction.order_id, order.id);

  const completion = db.orderToOutbound(order.id, [{
    product_id: product.id, quantity: 4, unit_price: order.unit_price, unit: '个'
  }], '测试操作员');
  assert.equal(completion.order.status, '已发货');
  assert.equal(db.getProduct(product.id).stock, 4);
  assert.equal(db.getCustomer(customer.id).debt, 75);
  assert.equal(db.listLedger().filter(row => row.party_id === customer.id && row.type === 'receivable').reduce((sum, row) => sum + row.amount, 0), 75);

  // Voiding part of a fully shipped order reopens the ready-stock order and
  // reverses only that shipment's stock and receivable posting.
  db.deleteTransaction(completion.transactions[0].transaction.id);
  assert.equal(db.listOrders().find(row => row.id === order.id).status, '待发货');
  assert.equal(db.getProduct(product.id).stock, 8);
  assert.equal(db.getCustomer(customer.id).debt, 25);
  db.deleteTransaction(partial.transactions[0].transaction.id);
  assert.equal(db.listOrders().find(row => row.id === order.id).status, '待发货');
  assert.equal(db.getProduct(product.id).stock, 10);
  assert.equal(db.getCustomer(customer.id).debt, 0);

  const reshipment = db.orderToOutbound(order.id, [{
    product_id: product.id, quantity: 6, unit_price: order.unit_price, unit: '个'
  }], '测试操作员');
  assert.equal(reshipment.order.status, '已发货');
  assert.equal(db.getProduct(product.id).stock, 4);
  assert.equal(db.getCustomer(customer.id).debt, 75);
  db.deleteTransaction(reshipment.transactions[0].transaction.id);
  assert.equal(db.listOrders().find(row => row.id === order.id).status, '待发货', 'repeated reversals use the latest shipment status history');
  assert.equal(db.getProduct(product.id).stock, 10);
  assert.equal(db.getCustomer(customer.id).debt, 0);

  const excessive = db.addOrder({
    order_no: 'READY-STOCK-TOO-MUCH',
    customer_id: customer.id,
    quantity: 11,
    unit: '个',
    unit_price: 12.5,
    status: '待发货'
  });
  // Include the new order in both snapshots; the failed shipment must not
  // mutate anything beyond the already-created order row.
  const beforeFailedShipment = JSON.stringify(db.backupData());
  assert.throws(() => db.orderToOutbound(excessive.id, [{
    product_id: product.id, quantity: 11, unit_price: 12.5, unit: '个'
  }]), /库存不足/);
  assert.equal(JSON.stringify(db.backupData()), beforeFailedShipment);

  const cancelled = db.addOrder({
    order_no: 'READY-STOCK-CANCELLED',
    customer_id: customer.id,
    quantity: 1,
    unit: '个',
    status: '已取消'
  });
  assert.throws(() => db.orderToOutbound(cancelled.id, [{ product_id: product.id, quantity: 1 }]), /待发货或生产中/);

  const closed = db.addOrder({
    order_no: 'READY-STOCK-CLOSED',
    customer_id: customer.id,
    quantity: 1,
    unit: '个',
    unit_price: 12.5,
    status: '待发货'
  });
  const closedShipment = db.orderToOutbound(closed.id, [{
    product_id: product.id, quantity: 1, unit_price: 12.5, unit: '个'
  }]);
  db.updateOrder(closed.id, { status: '已完成' });
  assert.throws(() => db.orderToOutbound(closed.id, [{ product_id: product.id, quantity: 1 }]), /待发货或生产中/);
  db.deleteTransaction(closedShipment.transactions[0].transaction.id);
  assert.equal(db.listOrders().find(row => row.id === closed.id).status, '待发货');
  assert.equal(db.getCustomer(customer.id).debt, 0);
  assert.equal(db.getProduct(product.id).stock, 10);

  // Keep the original production-order flow working and restore its previous
  // state on a shipment reversal.
  const legacy = db.addOrder({
    order_no: 'LEGACY-PRODUCTION-001',
    customer_id: customer.id,
    quantity: 1,
    unit: '个',
    unit_price: 12.5,
    status: '生产中'
  });
  const legacyShipment = db.orderToOutbound(legacy.id, [{
    product_id: product.id, quantity: 1, unit_price: 12.5, unit: '个'
  }]);
  assert.equal(legacyShipment.order.status, '已发货');
  db.deleteTransaction(legacyShipment.transactions[0].transaction.id);
  assert.equal(db.listOrders().find(row => row.id === legacy.id).status, '生产中');
  assert.equal(db.getCustomer(customer.id).debt, 0);
  assert.equal(db.getProduct(product.id).stock, 10);
  assert.equal(db.listSuppliers().find(row => row.id === supplier.id).payable, 200);
  db.validateBackup(db.backupData());
});

test('customer specification quick order targets already-produced finished-goods stock', () => {
  const routeHandlers = new Map();
  const customer = {
    id: 'dimensions-customer',
    name: '尺寸本客户',
    specs: [{
      id: 'carton-spec',
      goods: '常用纸箱',
      size: '40×30×20',
      sizeUnit: 'cm',
      material: 'B楞',
      unit: '个',
      kind: '成品'
    }]
  };
  const createdOrders = [];
  const party = { id: 17, name: customer.name };
  const fakeDb = {
    getCustomerDimensions: () => ({ customers: [customer] }),
    listCustomers: () => [party],
    addOrder: order => { createdOrders.push(order); return order; },
    revision: () => 1,
    transact: (_user, _key, _fingerprint, _expected, _label, operation) => ({ revision: 2, data: operation() })
  };
  const router = { get: (url, handler) => routeHandlers.set(`GET ${url}`, handler), put: (url, handler) => routeHandlers.set(`PUT ${url}`, handler), post: (url, handler) => routeHandlers.set(`POST ${url}`, handler) };
  require('./customer-dimensions').install(router, fakeDb);

  let response;
  let failure;
  const req = {
    body: { customer_id: customer.id, spec_id: 'carton-spec', quantity: 4, unit_price: 3.5 },
    user: { role: 'admin', id: 'admin' },
    get: name => ({ 'Idempotency-Key': 'dimensions-order-test-0001', 'If-Match': '1' })[name]
  };
  const res = { set: () => res, json: value => { response = value; return res; } };
  routeHandlers.get('POST /customer-dimensions/order')(req, res, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(response.success, true);
  assert.equal(createdOrders[0].status, '待发货');
});
