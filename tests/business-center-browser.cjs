const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, webkit, expect } = require('@playwright/test');

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'business-workbench-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(temporary, 'accounts.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], orders: [], ledger: [], _meta: {} }));
  fs.writeFileSync(process.env.WAREHOUSE_ACCOUNTS_FILE, JSON.stringify({ users: [{ id: 'test-admin', username: 'isolated-admin', role: 'admin', disabled: false }], events: [] }));
  const backendRoot = path.resolve(process.env.BUSINESS_BACKEND_ROOT || 'backend');
  const db = require(path.join(backendRoot, 'db'));
  const app = express(); app.use(express.json({ limit: '18mb' })); app.use('/api', require(path.join(backendRoot, 'team'))(db));
  const root = path.resolve(process.env.BUSINESS_WEB_DIR || process.env.TARO_OUTPUT_DIR || 'dist');
  app.use(express.static(root));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const engine = process.env.BUSINESS_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch();
  const artifacts = path.resolve(process.env.BUSINESS_EVIDENCE_DIR || 'release/business-workbench-check');
  fs.mkdirSync(artifacts, { recursive: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await context.addInitScript(() => { if (/^https?:$/.test(location.protocol)) localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true })); });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device' } });
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Warehouse-Revision' } });
      }
      return url.origin === origin ? route.continue() : route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const workbench = () => page.getByTestId('simple-workbench');
    const go = async hash => { await page.goto('about:blank'); await page.goto(origin + '/#' + hash); await expect(workbench()).toBeVisible(); await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible(); };
    const click = text => page.getByText(text, { exact: true }).locator('xpath=ancestor-or-self::*[self::taro-button-core or self::button or self::div][1]').click();

    const batch = db.receiveBoard({ supplier: '示例板厂', date: '2026-10-19', boardLength: 160, boardWidth: 110, cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B', layers: 3, orderedQty: 120, receivedQty: 120, billedArea: 211.2, unitPrice: 1, deliveryNo: 'L001', location: 'A01' });
    db.completeProduction({ batch_id: batch.id, product_name: '成品纸箱', consumed_quantity: 20, quantity: 18 }, '验证操作员');
    const customer = db.addCustomer({ name: '示例客户', debt: 0 });
    db.addSupplier({ name: '示例供货商', payable: 211.2 });
    db.addOrder({ order_no: 'TEST-ORDER-1', customer_id: customer.id, customer_name: customer.name, specification: '40 × 30 × 20 cm', material: 'B楞', quantity: 18, unit: '个', unit_price: 18, amount: 324, delivery_date: '2026-10-25', status: '待生产', remark: '隔离验证订单' });

    await go('/pages/business-center/index');
    await expect(page.getByText('办理业务', { exact: true })).toBeVisible();
    assert.equal(await page.getByTestId('workbench-actions').locator('taro-button-core').count(), 4);
    await page.screenshot({ path: path.join(artifacts, 'workbench-home.png'), fullPage: true });

    await click('库存');
    await expect(page.getByTestId('workbench-board')).toContainText('160 × 110 cm');
    await expect(page.getByTestId('workbench-board')).toContainText('成箱 40 × 30 × 20 cm');
    await page.getByLabel('搜索库存').locator('input').fill('40*30*20');
    await expect(page.getByTestId('workbench-board')).toHaveCount(1);
    await page.getByLabel('搜索库存').locator('input').fill('不存在');
    await expect(page.getByTestId('workbench-board')).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, 'workbench-stock.png'), fullPage: true });

    await page.goto('about:blank');
    await page.goto(origin + '/#/pages/customers/index');
    await expect(page.getByText('办理业务', { exact: true })).toBeVisible();
    await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible();
    await click('记收款');
    await expect(page.getByText('客户账单', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('示例客户', { exact: true })).toBeVisible();
    await expect(page.getByText('客户单据照片', { exact: true })).toHaveCount(0);
    await click('新增客户');
    await expect(page.getByTestId('customer-editor')).toBeVisible();
    await page.getByLabel('关闭资料抽屉').click();
    await click('供货商账单');
    await expect(page.getByText('示例供货商', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'workbench-bills.png'), fullPage: true });

    await page.goto('about:blank');
    await page.goto(origin + '/#/pages/suppliers/index');
    await expect(page.getByText('办理业务', { exact: true })).toBeVisible();
    await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible();
    await click('记收款');
    await expect(page.getByText('供货商账单', { exact: true }).first()).toBeVisible();
    await page.goto('about:blank');
    await page.goto(origin + '/#/pages/inventory/index');
    await expect(page.getByText('办理业务', { exact: true })).toBeVisible();
    await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible();
    await click('库存');
    await expect(page.getByText('查看库存', { exact: true })).toBeVisible();

    await go('/pages/business-center/index?detail=1');
    await expect(page.getByText('规格与订单', { exact: true })).toBeVisible();
    await expect(page.getByTestId('workbench-order')).toContainText('示例客户');
    await page.getByLabel('搜索订单').locator('input').fill('不存在订单');
    await expect(page.getByText('没有找到匹配订单', { exact: true })).toBeVisible();

    await go('/pages/business-center/index');
    await click('入库');
    await expect(page.getByText('纸板入库', { exact: true })).toBeVisible();
    await expect(page.getByText('纸箱入库', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'workbench-inbound.png'), fullPage: true });

    await go('/pages/business-center/index');
    await click('记收款');
    await click('上传送货单照片');
    await expect(page.getByText('原件照片按业务账单保存', { exact: false })).toBeVisible();

    for (const width of [320, 390, 430, 736, 1280]) {
      await go('/pages/business-center/index');
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await workbench().evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'no horizontal overflow ' + width);
      await page.screenshot({ path: path.join(artifacts, 'workbench-' + width + '.png'), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('PASS workbench: home actions, stock search, customer/supplier separation, order search, inbound split, photo return, legacy route takeover and responsive layouts');
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
