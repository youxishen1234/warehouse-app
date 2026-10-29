const { clickWorkbenchAction } = require('./demo-ui-actions.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');
async function main() {
  const artifacts = path.resolve(process.env.WORKBENCH_REFERENCE_EVIDENCE_DIR || 'release/business-ui-reference-20261019/reference-evidence'); fs.mkdirSync(artifacts, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(artifacts, 'isolated-data-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('../backend/db');
  const app = express(); app.use(express.json({ limit: '18mb' })); app.use('/api', require('../backend/team')(db));
  app.use(express.static(path.resolve(process.env.WORKBENCH_REFERENCE_WEB_DIR || process.env.TARO_OUTPUT_DIR || 'release/business-ui-reference-20261019/web')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const contexts = [];
  const errors = [];
  const setup = async width => {
    const context = await browser.newContext({ viewport: { width, height: 900 } }); contexts.push(context);
    await context.addInitScript(() => { if (/^https?:$/.test(location.protocol)) localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true })); });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device' } });
        try {
          const response = await route.fetch({ url: origin + url.pathname + url.search });
          return await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Warehouse-Revision' } });
        } catch (error) { if (!/disposed|closed/i.test(String(error))) throw error; }
        return;
      }
      return url.origin === origin ? route.continue() : route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(12000);
    return page;
  };
  const go = async page => { await page.goto('about:blank'); await page.goto(origin + '/#/pages/home/index'); await expect(page.getByText('更多', { exact: true })).toBeVisible(); await expect(page.getByText('● 已同步', { exact: true })).toBeVisible(); };
  const button = (scope, text) => ({ click: () => clickWorkbenchAction(scope, text) });
  try {
    // Isolated demonstration data only. No calls reach the live warehouse.
    const supplier = db.addSupplier({ name: '示例板厂' });
    const batch = db.receiveBoard({ supplier_id: supplier.id, supplier: supplier.name, date: '2026-10-19', boardLength: 160, boardWidth: 110, cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B', layers: 3, orderedQty: 120, receivedQty: 120, billedArea: 211.2, unitPrice: 1 });
    const completed = db.completeProduction({ batch_id: batch.id, product_name: '成品 B', consumed_quantity: 100, quantity: 100 }, '学习操作员');
    await new Promise(resolve => setTimeout(resolve, 10));
    const customer = db.addCustomer({ name: '示例客户' });
    db.stockOut(completed.product_id, 4, '学习操作员', '学习示例', customer.id, { unit_price: 18 });
    await new Promise(resolve => setTimeout(resolve, 10));
    db.settleParty('customer', customer.id, 50, '转账 · 学习示例');
    const page = await setup(849); await page.setViewportSize({ width: 849, height: 1068 }); await go(page);
    const root = page.getByTestId('simple-workbench');
    await expect(root).toHaveAttribute('data-layout', 'demo-layout-v1');
    await expect(page.getByTestId('workbench-content')).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-tab-context', '');
    await expect(page.locator('body')).not.toHaveAttribute('data-simple-workbench-active', '');
    const dock = page.locator('taro-tabbar.sg-glass-host');
    await expect(dock).toBeVisible();
    await expect(dock.locator('.sg-app-nav button[data-tab]')).toHaveCount(5);
    await expect(dock.locator('.sg-app-nav button[data-tab="0"]')).toHaveAttribute('aria-current', 'page');
    await dock.locator('.sg-app-nav button[data-tab="0"]').click();
    await page.waitForURL(/\/pages\/home\/index/);
    await expect(page.getByTestId('simple-workbench')).toBeVisible();
    await go(page);
    const feed = page.getByTestId('workbench-today');
    await expect(feed).toContainText('示例客户 · 收款记录'); await expect(feed).toContainText('¥50.00');
    await expect(feed).toContainText('示例客户 · 出库单'); await expect(feed).toContainText('¥72.00');
    await expect(feed).toContainText('成品 B · 生产单'); await expect(feed).toContainText('100 个');
    assert.equal(await feed.locator('taro-button-core').count(), 3);
    await page.screenshot({ path: path.join(artifacts, 'reference-home-desktop.png'), fullPage: true });
    for (const width of [320, 390, 736, 1280]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1068 });
      const pageRoot = page.getByTestId('simple-workbench');
      const geometry = await pageRoot.boundingBox();
      if (width >= 1024) assert.ok(geometry.x >= 209, 'desktop page clears the 210px liquid sidebar: ' + JSON.stringify(geometry));
      else assert.ok(Math.abs(geometry.x - Math.max(0, (width - 430) / 2)) < 1, 'demo shell stays centered: ' + JSON.stringify(geometry));
      assert.ok(await pageRoot.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'no horizontal overflow');
      await page.screenshot({ path: path.join(artifacts, 'reference-home-' + width + '.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await clickWorkbenchAction(page.getByTestId('simple-workbench'), '纸板入库');
    await expect(page).toHaveURL(/pages\/management\/index\?section=paperboard-receipt/);
    await page.screenshot({ path: path.join(artifacts, 'reference-inbound.png'), fullPage: true });
    await go(page); await button(page.getByTestId('simple-workbench').filter({ visible: true }).last(), '收付款 / 账单').click();
    await expect(page.getByTestId('finance-center').filter({ visible: true }).last()).toBeVisible();
    await page.getByTestId('finance-tab-customer').click(); await page.getByText('查看明细 ›', { exact: true }).first().click();
    await expect(page.getByTestId('finance-customer-view')).toBeVisible();
    await expect(page.locator('[data-testid^="customer-bill-"]').filter({ hasText: '示例客户' })).toContainText('当前待收款 ¥22.00');
    await button(page.getByTestId('simple-workbench').filter({ visible: true }).last(), '供货商账单').click();
    await expect(page.getByTestId('finance-supplier-view')).toBeVisible();
    await expect(page.locator('[data-testid^="supplier-bill-"]').filter({ hasText: '示例板厂' })).toContainText('当前待付款 ¥211.20');
    await page.screenshot({ path: path.join(artifacts, 'reference-bills.png'), fullPage: true });
    await page.locator('[aria-label="返回总台"]:visible').last().click();
    await button(page, '示例客户 · 收款记录').click();
    await expect(page.getByRole('dialog', { name: '流水详情' })).toBeVisible();
    await expect(page.getByTestId('simple-workbench').filter({ visible: true }).last()).toBeVisible();
    await expect(page.getByTestId('finance-center').filter({ visible: true }).last()).toBeVisible();
    await expect(page.getByTestId('simple-workbench').filter({ visible: true }).last()).toHaveAttribute('data-layout', 'demo-layout-v1');
    await expect(page.locator('html')).toHaveAttribute('data-tab-modal', '');
    await expect(page.locator('taro-tabbar.sg-glass-host')).toBeHidden();
    await page.getByRole('button', { name: '关闭流水详情', exact: true }).click();
    await expect(page.locator('taro-tabbar.sg-glass-host')).toBeVisible();
    await expect(page.locator('body')).not.toHaveAttribute('data-simple-workbench-active', '');
    await go(page); await button(page.getByTestId('simple-workbench'), '全部记录').click();
    await expect(page.getByText('出入库 / 生产', { exact: true })).toBeVisible();
    await page.locator('[aria-label="返回总台"]:visible').last().click(); await button(page.getByTestId('simple-workbench').filter({ visible: true }).last(), '成品 B · 生产单').click();
    await expect(page.getByText('领用 100 张 · 完工 100 个', { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
    console.log('PASS reference UI: liquid dock ownership, real home navigation, four actions, daily records, bills, deep links, 320/390/736/1280 widths');
  } finally {
    await Promise.all(contexts.map(c => c.close())); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
