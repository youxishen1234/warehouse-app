const fs = require('node:fs');
const path = require('node:path');
const express = require('../backend/node_modules/express');

const root = path.resolve(__dirname, '..');
const demoRoot = path.resolve(process.env.WAREHOUSE_DEMO_ROOT || path.join(root, 'release', 'demo-20261023'));
const webRoot = path.resolve(process.env.WAREHOUSE_DEMO_WEB_ROOT || path.join(demoRoot, 'web'));
const dataFile = path.resolve(process.env.WAREHOUSE_DEMO_DATA_FILE || path.join(demoRoot, 'data', 'data.json'));
const port = Number(process.env.WAREHOUSE_DEMO_PORT || 4012);
const reset = process.argv.includes('--reset');

if (!fs.existsSync(path.join(webRoot, 'index.html'))) throw new Error(`演示构建不存在: ${webRoot}`);
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
process.env.WAREHOUSE_DATA_FILE = dataFile;
process.env.WAREHOUSE_BACKUP_DIR = path.join(demoRoot, 'backups');
process.env.WAREHOUSE_PRODUCT_IMAGE_DIR = path.join(demoRoot, 'uploads', 'products');

const empty = () => ({
  products: [], customers: [], suppliers: [], transactions: [], orders: [], order_events: [],
  ledger: [], stocktakes: [], delivery_notes: [], print_notes: [], production_records: [],
  board_batches: [], board_movements: [],
  customer_dimensions: {
    schemaVersion: 1, revision: 0, customers: [],
    theme: { title: '客户尺寸本', accent: '#468cfb', bg: '#101319', card: '#202630' }
  },
  _meta: {
    schemaVersion: 1, nextProductId: 1, nextCustomerId: 1, nextSupplierId: 1,
    nextTransactionId: 1, nextLedgerId: 1, nextOrderId: 1, nextOrderEventId: 1,
    nextStocktakeId: 1, nextDeliveryNoteId: 1
  }
});

const fresh = reset || !fs.existsSync(dataFile);
if (fresh) fs.writeFileSync(dataFile, JSON.stringify(empty(), null, 2));

const db = require('../backend/db');

function localDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function seed() {
  const customers = {
    sunrise: db.addCustomer({ name: '曙光食品', contact: '王经理', phone: '138 0000 1024', address: '城南工业园 18 号', remark: '礼盒与食品外箱' }),
    xinxing: db.addCustomer({ name: '新兴商贸', contact: '陈女士', phone: '139 0000 2088', address: '物流大道 6 号', remark: '电商小箱常客' }),
    qinghe: db.addCustomer({ name: '青禾包装', contact: '刘师傅', phone: '137 0000 3311', address: '开发区兴业路 9 号', remark: '加强箱客户' })
  };
  const suppliers = {
    board: db.addSupplier({ name: '东光板厂', contact: '赵师傅', phone: '135 0000 5100', address: '东光工业区', remark: '三层 B 楞' }),
    carton: db.addSupplier({ name: '恒信纸箱厂', contact: '周经理', phone: '136 0000 6200', address: '北环纸品园', remark: '外购成品箱' })
  };
  const products = {
    gift: db.addProduct({ name: '曙光礼盒箱', category: '纸箱', specification: '30×20×15 cm', material: '牛皮纸', corrugation: 'B', layers: 3, unit: '个', price: 1.8, stock: 240, safety_stock: 80, supplier_id: suppliers.carton.id }),
    handbag: db.addProduct({ name: '客户供箱·手提箱', category: '纸箱', specification: '40×30×25 cm', material: '白卡纸', corrugation: 'E', layers: 3, unit: '个', price: 0, stock: 120, safety_stock: 30 }),
    aircraft: db.addProduct({ name: '三层飞机盒', category: '纸箱', specification: '40×30×20 cm', material: '牛卡', corrugation: 'B', layers: 3, unit: '个', price: 2.6, stock: 860, safety_stock: 150, supplier_id: suppliers.carton.id }),
    reinforced: db.addProduct({ name: '五层加强箱', category: '纸箱', specification: '60×40×40 cm', material: '牛卡', corrugation: 'BC', layers: 5, unit: '个', price: 12.5, stock: 96, safety_stock: 40, supplier_id: suppliers.carton.id }),
    ecommerce: db.addProduct({ name: '小号电商箱', category: '纸箱', specification: '20×15×10 cm', material: '瓦楞纸', corrugation: 'E', layers: 3, unit: '个', price: 1.2, stock: 340, safety_stock: 60 })
  };

  const dims = db.getCustomerDimensions();
  dims.customers = [
    {
      id: 'demo-sunrise', name: customers.sunrise.name,
      specs: [
        { id: 'sunrise-gift', goods: '曙光礼盒外箱', size: '30×20×15', sizeUnit: 'cm', material: '牛皮纸', unit: '个', kind: '成品' },
        { id: 'sunrise-handbag', goods: '手提礼盒', size: '40×30×25', sizeUnit: 'cm', material: '白卡纸', unit: '个', kind: '成品' }
      ]
    },
    {
      id: 'demo-xinxing', name: customers.xinxing.name,
      specs: [{ id: 'xinxing-mailer', goods: '电商发货箱', size: '20×15×10', sizeUnit: 'cm', material: '瓦楞纸', unit: '个', kind: '成品' }]
    },
    {
      id: 'demo-qinghe', name: customers.qinghe.name,
      specs: [
        { id: 'qinghe-heavy', goods: '加强运输箱', size: '60×40×40', sizeUnit: 'cm', material: '牛卡', unit: '个', kind: '成品' },
        { id: 'qinghe-board', goods: '来料纸板', size: '165×115', sizeUnit: 'cm', material: 'B楞三层', unit: '张', kind: '纸板' }
      ]
    }
  ];
  const updatedDims = db.updateCustomerDimensions(dims);
  if (!updatedDims) throw new Error('客户规格演示数据保存失败');

  const batch = db.receiveBoard({
    supplier: suppliers.board.name, supplier_id: suppliers.board.id,
    boardLength: 165, boardWidth: 115,
    cartonLength: 40, cartonWidth: 30, cartonHeight: 20,
    fluteType: 'B', layers: 3, faceGsm: 150, linerGsm: 150, flutingGsm: 120,
    orderedQty: 1000, receivedQty: 1004, billedArea: 1897.5, unitPrice: 2.1,
    date: localDate(), deliveryNo: 'DEMO-BOARD-1001', location: 'A区-03', warningQty: 200,
    remark: '演示批次：东光板厂三层 B 楞'
  });

  db.completeProduction({
    batch_id: batch.id, product_id: products.aircraft.id,
    consumed_quantity: 10, quantity: 480, remark: '客户加急订单'
  }, '演示操作员');

  db.addDeliveryNote({
    party_type: 'customer', customer_id: customers.sunrise.id, customer_name: customers.sunrise.name,
    date: localDate(), work_order_no: 'DEMO-CUSTOMER-BOX-001', freight: 15,
    remark: '客户送来手提礼盒箱，只增加库存', operator: '演示操作员',
    lines: [{ product_id: products.handbag.id, quantity: 80, delivered_qty: 80, unit_price: 0, specification: products.handbag.specification }]
  });
  db.addDeliveryNote({
    party_type: 'supplier', supplier_id: suppliers.carton.id, supplier_name: suppliers.carton.name,
    date: localDate(), work_order_no: 'DEMO-SUPPLIER-BOX-001', freight: 20,
    remark: '恒信纸箱厂补货', operator: '演示操作员',
    lines: [{ product_id: products.reinforced.id, quantity: 200, delivered_qty: 200, unit_price: 3.2, specification: products.reinforced.specification }]
  });

  const orderOne = db.addOrder({
    order_no: 'DD-20261023-001', customer_id: customers.sunrise.id,
    specification: '30×20×15 cm', material: '牛皮纸', quantity: 120, unit: '个',
    unit_price: 1.8, delivery_date: localDate(), status: '生产中', remark: '中秋礼盒返单'
  });
  db.orderToOutbound(orderOne.id, [{ product_id: products.gift.id, quantity: 80 }], '演示操作员', '首批出库 80 个');
  db.addOrder({
    order_no: 'DD-20261023-002', customer_id: customers.xinxing.id,
    specification: '20×15×10 cm', material: '瓦楞纸', quantity: 60, unit: '个',
    unit_price: 1.2, delivery_date: localDate(1), status: '待生产', remark: '明天送货'
  });

  const printDraft = db.savePrintNote({
    company: '曙光纸箱包装', customer_id: customers.qinghe.id,
    customer_name: customers.qinghe.name, address: customers.qinghe.address,
    phone: customers.qinghe.phone, receiver: '刘师傅', sender: '演示操作员',
    date: localDate(), paper: 'a4',
    items: [{
      product_id: products.reinforced.id, name: products.reinforced.name,
      specification: products.reinforced.specification, unit: '个',
      quantity: 12, price: 12.5, remark: ''
    }]
  });
  db.shipPrintNote(printDraft.id);

  db.settleParty('customer', customers.sunrise.id, 60, '微信到账 · 演示收款');
  db.settleParty('supplier', suppliers.board.id, 500, '银行转账 · 演示付款');

  const check = db.backupData();
  db.validateBackup(check);
  return {
    customers: db.listCustomers().length,
    suppliers: db.listSuppliers().length,
    products: db.listProducts().length,
    boards: db.listBoards().length,
    orders: db.listOrders().length,
    printNotes: db.listPrintNotes().length,
    ledger: db.listLedger().length
  };
}

if (fresh) {
  const summary = seed();
  console.log('[demo] seeded', JSON.stringify(summary));
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));
app.use('/api', require('../backend/team')(db));
app.use('/uploads/products', express.static(process.env.WAREHOUSE_PRODUCT_IMAGE_DIR, { dotfiles: 'deny', index: false }));
app.use(express.static(webRoot, { index: 'index.html' }));
app.get(/.*/, (req, res, next) => {
  if (req.method !== 'GET' || path.extname(req.path)) return next();
  res.sendFile(path.join(webRoot, 'index.html'));
});
app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = Number.isInteger(error?.status) ? error.status : 500;
  res.status(status).json({ success: false, message: status >= 500 ? '演示服务暂时无法处理请求' : error.message });
});

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`[demo] http://127.0.0.1:${port}/#/pages/home/index`);
  console.log(`[demo] data ${dataFile}`);
});
server.on('error', error => { console.error('[demo]', error.message); process.exitCode = 1; });

function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
