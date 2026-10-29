const { clickWorkbenchAction } = require('./demo-ui-actions.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const artifacts = path.resolve(process.env.WORKBENCH_LAYOUT_EVIDENCE_DIR || 'release/workbench-layout-20261024/evidence');
  fs.mkdirSync(artifacts, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(artifacts, 'isolated-data-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], orders: [], ledger: [],
    stocktakes: [], delivery_notes: [], production_records: [], board_batches: [], board_movements: [],
    _meta: { schemaVersion: 1, nextProductId: 1, nextCustomerId: 1, nextSupplierId: 1, nextTransactionId: 1, nextLedgerId: 1 }
  }));

  const db = require('../backend/db');
  const longProductName = '超长商品名称用于验证窄屏业务记录不会挤出卡片边界的纸箱规格';
  const product = db.addProduct({
    name: longProductName, category: '纸箱', specification: '30×20×15 cm', unit: '个',
    price: 2, stock: 10, safety_stock: 2
  });
  db.stockOut(product.id, 1, '布局回归测试', 'isolated fixture');

  const app = express();
  app.use(express.json({ limit: '18mb' }));
  app.use('/api', require('../backend/team')(db));
  app.use(express.static(path.resolve(process.env.WORKBENCH_POLISH_WEB_DIR || process.env.TARO_OUTPUT_DIR || 'release/workbench-layout-20261024/web')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const contexts = [];
  const errors = [];

  const setup = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(context);
    await context.addInitScript(() => {
      if (/^https?:$/.test(location.protocol)) {
        localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
      }
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        if (route.request().method() === 'OPTIONS') {
          return route.fulfill({
            status: 204,
            headers: {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
              'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device'
            }
          });
        }
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({
          response,
          headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Warehouse-Revision' }
        });
      }
      return url.origin === origin ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(12000);
    return page;
  };
  const page = await setup();
  const button = (scope, text) => ({ click: () => clickWorkbenchAction(scope, text) });
  const home = page.getByTestId('simple-workbench');

  try {
    await page.goto(origin + '/#/pages/home/index');
    await expect(page.getByText('更多', { exact: true })).toBeVisible();
    await expect(page.getByText('● 已同步', { exact: true })).toBeVisible();

    await expect(page.getByTestId('workbench-today')).toContainText(longProductName);
    const activity = page.getByTestId('workbench-today').locator('taro-button-core').first();
    for (const width of [320, 390, 430, 736, 1280]) {
      await page.setViewportSize({ width, height: width === 320 ? 700 : 900 });
      const root = page.getByTestId('simple-workbench');
      const geometry = await root.boundingBox();
      assert.ok(geometry.width > 0 && geometry.width <= Math.min(430, width) + 1);
      assert.ok(Math.abs(geometry.x - (width - geometry.width) / 2) <= 1);
      assert.ok(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'no horizontal overflow');
      const cards = root.getByTestId('workbench-actions').locator('taro-button-core');
      assert.equal(await cards.count(), 4);
      const boxes = await cards.evaluateAll(nodes => nodes.map(el => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y, height: el.getBoundingClientRect().height })));
      assert.ok(boxes.every((box, i) => box.height >= 44 && Math.abs(box.y - boxes[0].y) < 2 && (!i || box.x > boxes[i - 1].x)), 'four shortcuts use one ordered row');
      assert.deepEqual(await cards.allTextContents(), ['收付款', '客户', '供货商', '更多']);
      const title = await activity.locator('[class*="activityTitle"]').evaluate(el => ({ width: el.getBoundingClientRect().width, available: el.closest('taro-button-core').getBoundingClientRect().width }));
      assert.ok(title.width <= title.available, 'long activity titles stay within their card');
      await page.screenshot({ path: path.join(artifacts, 'demo-home-' + width + '.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await button(home, '收付款 / 账单').click();
    for (const view of ['overview', 'customer', 'supplier', 'ledger']) {
      await page.getByTestId('finance-tab-' + view).click();
      await expect(page.getByTestId('finance-' + view + '-view')).toBeVisible();
    }
    await page.locator('.sg-app-nav button[data-tab="2"]').click();
    await page.waitForURL(/pages\/inventory\/index/);
    const inventory = page.getByTestId('simple-workbench').filter({ visible: true }).last();
    await expect(inventory).toHaveAttribute('data-panel', 'stock');
    await button(inventory, '纸箱').click();
    await page.setViewportSize({ width: 320, height: 320 });
    await button(inventory, '盘点 / 调整库存').click();
    const dialog = page.getByRole('dialog', { name: '库存盘点' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 321, 'stocktake sheet fits short screens');
    assert.ok(await dialog.evaluate(el => el.scrollHeight > el.clientHeight), 'all sheet fields remain scrollable');
    assert.deepEqual(errors, []);
    console.log('PASS business-center layout: compact two-by-two actions at 320/390/430/736/1280px; guidance, long activity title, finance entry and short-screen dialog verified.');
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
