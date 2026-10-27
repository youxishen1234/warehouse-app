const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('../backend/node_modules/express');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const webRoot = path.resolve(process.env.STOCK_WARNING_WEB_DIR || process.env.TARO_OUTPUT_DIR || 'release/cancel-stock-warning-20261027/web');
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `H5 build is missing: ${webRoot}`);
  const artifacts = path.resolve(process.env.STOCK_WARNING_EVIDENCE_DIR || 'release/cancel-stock-warning-20261027/stock-warning-evidence');
  fs.mkdirSync(artifacts, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-stock-warning-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], orders: [], ledger: [] }));

  const db = require('../backend/db');
  const configuredZeroStock = db.addProduct({ name: '配置预警的零库存商品', category: '纸箱', unit: '个', price: 3, stock: 0, safety_stock: 5 });
  const unconfiguredZeroStock = db.addProduct({ name: 'sjfhjs', category: '纸箱', unit: '个', price: 1, stock: 0, safety_stock: 0 });
  const recordProduct = db.addProduct({ name: '出入库记录测试商品', category: '纸箱', unit: '个', price: 2, stock: 0 });
  db.stockIn(recordProduct.id, 6, '隔离回归测试', '隔离测试入库');
  db.stockOut(recordProduct.id, 2, '隔离回归测试', '隔离测试出库');
  assert.equal(db.getProduct(configuredZeroStock.id).stock, 0);
  assert.equal(db.getProduct(unconfiguredZeroStock.id).stock, 0);
  assert.ok(db.stats().lowStock >= 2, 'the API fixture must expose low-stock data');
  const initialData = JSON.stringify(db.backupData());

  const app = express();
  app.use(express.json({ limit: '18mb' }));
  app.use('/api', require('../backend/team')(db));
  app.use(express.static(webRoot));
  app.get('*', (_req, res) => res.sendFile(path.join(webRoot, 'index.html')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const contexts = [];
  const errors = [];

  const setup = async width => {
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 700 : 900 } });
    contexts.push(context);
    await context.addInitScript(() => {
      if (/^https?:$/.test(location.protocol)) localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        if (route.request().method() === 'OPTIONS') return route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device'
          }
        });
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Warehouse-Revision' } });
      }
      return url.origin === origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(12000);
    return page;
  };

  const activeRoot = page => page.locator('.taro_page:visible').last().getByTestId('simple-workbench');
  const assertNoWarningSurface = async root => {
    await expect(root.getByTestId('workbench-stock-notice')).toHaveCount(0);
    assert.doesNotMatch(await root.innerText(), /库存预警|库存提醒/, 'workbench must not show stock warnings');
  };
  const assertNoOverflow = async (page, root, width) => {
    assert.ok(await root.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `workbench overflow at ${width}px`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `document overflow at ${width}px`);
  };

  try {
    browser = await chromium.launch();
    const statsResponse = await fetch(`${origin}/api/stats`);
    assert.equal(statsResponse.status, 200, 'isolated stats API is available');
    const statsEnvelope = await statsResponse.json();
    assert.equal(statsEnvelope.success, true);
    assert.ok(statsEnvelope.data.lowStock >= 2, 'API still reports zero-stock products as low stock');
    assert.equal(statsEnvelope.data.todayIn, 6);
    assert.equal(statsEnvelope.data.todayOut, 2);

    for (const [routeName, routePath] of [['home', '/#/pages/home/index'], ['business-center', '/#/pages/business-center/index']]) {
      const page = await setup(390);
      await page.goto(origin + routePath);
      await expect(page.getByText('办理业务', { exact: true })).toBeVisible();
      const root = activeRoot(page);
      await expect(root.getByTestId('workbench-sync-status')).toContainText('服务器数据已读取 · 多设备自动同步');
      await assertNoWarningSurface(root);
      await expect(root.getByText('sjfhjs', { exact: true })).toHaveCount(0, 'zero-stock product is not surfaced on the home workbench');
      const feed = root.getByTestId('workbench-today');
      await expect(feed).toContainText('出入库记录测试商品');
      await expect(feed).toContainText('入库单');
      await expect(feed).toContainText('出库单');
      if (routeName === 'home') {
        const summary = root.getByTestId('workbench-summary');
        await expect(summary).toBeVisible();
        await expect(summary.getByText('6', { exact: true })).toBeVisible();
        await expect(summary.getByText('2', { exact: true })).toBeVisible();
      } else {
        await expect(root.getByTestId('workbench-summary')).toHaveCount(0);
      }
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: width === 320 ? 700 : 900 });
        await assertNoWarningSurface(root);
        await assertNoOverflow(page, root, width);
        await page.screenshot({ path: path.join(artifacts, `${routeName}-${width}.png`), fullPage: true });
      }
      const refresh = root.locator('[aria-label="刷新服务器数据"]');
      await expect(refresh).toBeVisible();
      await refresh.click();
      await expect(root.getByTestId('workbench-sync-status')).toContainText('服务器数据已读取 · 多设备自动同步');
      await assertNoWarningSurface(root);
      await page.close();
    }

    const inventoryPage = await setup(390);
    await inventoryPage.goto(origin + '/#/pages/home/index');
    await expect(activeRoot(inventoryPage).getByTestId('workbench-summary')).toBeVisible();
    await inventoryPage.locator('.sg-glass-dock button[data-tab="2"]').click();
    await inventoryPage.waitForURL(/\/pages\/inventory\/index/);
    const inventoryRoot = activeRoot(inventoryPage);
    await expect(inventoryRoot.getByText('查看库存', { exact: true })).toBeVisible();
    await inventoryRoot.getByText('纸箱', { exact: true }).click();
    const inventoryRow = inventoryRoot.getByTestId('workbench-carton').filter({ hasText: 'sjfhjs' });
    await expect(inventoryRow).toContainText('sjfhjs');
    await expect(inventoryRow).toContainText('0 个');
    await assertNoWarningSurface(inventoryRoot);
    assert.equal(db.getProduct(unconfiguredZeroStock.id).stock, 0, 'opening the inventory page does not change stock');
    assert.equal(JSON.stringify(db.backupData()), initialData, 'UI reads do not mutate isolated warehouse data');
    assert.deepEqual(errors, [], 'no browser page errors');
    console.log('PASS stock-warning removal: configured and unconfigured zero-stock products with nonzero API warnings do not appear on the home workbench, daily summaries and inventory navigation remain intact, responsive layouts fit, and isolated data is unchanged.');
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
