const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname, '..');
  const webRoot = path.resolve(process.env.PRODUCE_TO_STOCK_WEB_DIR || process.env.TARO_OUTPUT_DIR || path.join(root, 'dist'));
  const evidence = path.resolve(process.env.PRODUCE_TO_STOCK_EVIDENCE_DIR || path.join(root, 'release/produce-to-stock-20261025/ui-evidence'));
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `Missing H5 build: ${webRoot}`);
  fs.mkdirSync(evidence, { recursive: true });

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-produce-to-stock-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  process.env.WAREHOUSE_PRODUCT_IMAGE_DIR = path.join(temporary, 'products');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], orders: [], ledger: [], _meta: {} }));
  const db = require(path.join(root, 'backend/db'));
  const app = express();
  app.use(express.json({ limit: '18mb' }));
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match, Idempotency-Key, X-Warehouse-Device');
    res.set('Access-Control-Expose-Headers', 'X-Warehouse-Revision');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api', require(path.join(root, 'backend/team'))(db));
  app.use(express.static(webRoot));
  app.get('*', (_req, res) => res.sendFile(path.join(webRoot, 'index.html')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device', 'access-control-expose-headers': 'X-Warehouse-Revision' };
  await context.addInitScript(() => {
    if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    }
    return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  const noOverflow = async width => {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1)).toBe(true);
  };
  try {
    // Factory flow starts before customer order: paperboard purchase -> raw stock -> production -> finished stock.
    const batch = db.receiveBoard({ supplier: '流程测试纸板厂', date: require(path.join(root, 'backend/stock-math')).localDate(), boardLength: 160, boardWidth: 110, cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B', layers: 3, orderedQty: 80, receivedQty: 80, billedArea: 140.8, unitPrice: 1.5, deliveryNo: 'FLOW-BOARD-01' });
    const production = db.completeProduction({ batch_id: batch.id, product_name: '流程测试纸箱', consumed_quantity: 20, quantity: 12, remark: '先入库存货' }, '回归测试');
    const product = db.getProduct(production.product_id);
    assert.equal(db.listTx({ product_id: product.id, type: 'in' }).length, 1, 'production must post finished cartons once before an order exists');
    assert.equal(product.stock, 12);
    assert.equal(db.listOrders().length, 0, 'customer order is created after factory production');
    const customer = db.addCustomer({ name: '流程测试客户', specs: [{ id: 'flow-carton', goods: product.name, specification: product.specification, material: product.material, unit: product.unit, price: 2.5, category: '纸箱', kind: '成品' }] });
    assert.equal(db.getCustomer(customer.id).debt, 0);
    const boardOnHandBeforeOrder = db.listBoards().find(row => row.id === batch.id).remainingQty;

    await page.goto('about:blank');
    await page.goto(origin + '/#/pages/home/index');
    const flow = page.getByTestId('workbench-factory-flow');
    await expect(flow).toHaveCount(0);
    await page.getByText('＋ 客户开单', { exact: true }).click();
    await expect(page.getByTestId('order-stock-flow')).toBeVisible();
    await page.getByLabel('选择订单客户', { exact: true }).selectOption(String(customer.id));
    await expect(page.getByLabel('常用货物 / 规格', { exact: true })).toHaveValue('flow-carton');
    await page.getByLabel('订单数量', { exact: true }).fill('5');
    await page.getByLabel('订单单价', { exact: true }).fill('2.50');
    await noOverflow(320);
    await page.screenshot({ path: path.join(evidence, 'order-create-320.png'), fullPage: true });
    await noOverflow(390);
    await page.getByRole('button', { name: '保存订单 · 自动检查库存', exact: true }).click();
    await expect.poll(() => db.listOrders().length).toBe(1);
    await expect(page.getByTestId('customer-order-sheet')).toHaveCount(0);
    const order = db.listOrders()[0];
    await page.goto(origin + '/#/pages/customer-orders/index');
    await expect(page.getByTestId(`order-card-${order.id}`)).toBeVisible();

    assert.ok(order);
    assert.equal(order.status, '待发货', 'new order uses existing finished-goods inventory');
    assert.equal(order.amount, 12.5);
    assert.equal(db.getProduct(product.id).stock, 12, 'creating an order must not add or consume stock');
    assert.equal(db.getCustomer(customer.id).debt, 0, 'an order by itself does not book a receivable');
    assert.equal(db.listTx({ product_id: product.id }).length, 1, 'creating an order must not create a second inventory entry');
    assert.equal(db.listBoards().find(row => row.id === batch.id).remainingQty, boardOnHandBeforeOrder, 'an order must not consume more paperboard');

    const orderCard = page.getByTestId(`order-card-${order.id}`);
    await orderCard.getByRole('button', { name: '确认出库', exact: true }).click();
    await expect(page).toHaveURL(/pages\/management\/index\?section=shipment/);
    await expect(page.getByLabel('客户 / 订单', { exact: true })).toHaveValue(String(order.id));
    await expect(page.getByLabel('出库数量', { exact: true })).toHaveValue('5');
    await noOverflow(320);
    await page.screenshot({ path: path.join(evidence, 'outbound-ready-320.png'), fullPage: true });
    await noOverflow(390);
    await page.getByTestId('outbound-save').click();
    await expect.poll(() => db.getProduct(product.id).stock).toBe(7);
    await expect.poll(() => db.getCustomer(customer.id).debt).toBe(12.5);
    assert.equal(db.listOrders().find(row => row.id === order.id).status, '已发货');
    const shipment = db.listTx({ product_id: product.id, type: 'out' }).find(row => row.order_id === order.id);
    assert.ok(shipment, 'outbound transaction must remain associated with its order');
    assert.equal(shipment.amount, 12.5);
    const receivable = db.listLedger({ party_type: 'customer', party_id: customer.id }).find(row => row.type === 'receivable');
    assert.ok(receivable, 'shipment should create a customer receivable');
    assert.equal(receivable.amount, 12.5);
    assert.equal(db.listTx({ product_id: product.id, type: 'in' }).length, 1, 'shipment must not post another inbound transaction');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ flow: 'paperboard receipt → factory production inbound → customer order → shipment', orderStatus: order.status, orderAmount: order.amount, stockAfterShipment: db.getProduct(product.id).stock, receivable: db.getCustomer(customer.id).debt, widths: [320, 390], pageErrors: errors }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure.html'), await page.content().catch(() => ''), 'utf8');
    throw error;
  } finally {
    await context.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
