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
  const browser = await chromium.launch();
  const contexts = [];
  const errors = [];
  const setup = async width => {
    const context = await browser.newContext({ viewport: { width, height: 900 } }); contexts.push(context);
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
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(12000);
    return page;
  };
  const go = async page => { await page.goto('about:blank'); await page.goto(origin + '/#/pages/business-center/index'); await expect(page.getByText('办理业务', { exact: true })).toBeVisible(); await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible(); };
  const button = (scope, text) => scope.getByText(text, { exact: true }).last().locator('xpath=ancestor-or-self::*[self::taro-button-core or self::button][1]');
  try {
    // Isolated demonstration data only. No calls reach the live warehouse.
    const batch = db.receiveBoard({ supplier: '示例板厂', date: '2026-10-19', boardLength: 160, boardWidth: 110, cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B', layers: 3, orderedQty: 120, receivedQty: 120, billedArea: 211.2, unitPrice: 1 });
    const completed = db.completeProduction({ batch_id: batch.id, product_name: '成品 B', consumed_quantity: 100, quantity: 100 }, '学习操作员');
    await new Promise(resolve => setTimeout(resolve, 10));
    const customer = db.addCustomer({ name: '示例客户' });
    db.stockOut(completed.product_id, 4, '学习操作员', '学习示例', customer.id, { unit_price: 18 });
    await new Promise(resolve => setTimeout(resolve, 10));
    db.settleParty('customer', customer.id, 50, '转账 · 学习示例');
    const page = await setup(849); await page.setViewportSize({ width: 849, height: 1068 }); await go(page);
    const feed = page.getByTestId('workbench-today');
    await expect(feed).toContainText('示例客户 · 收款记录'); await expect(feed).toContainText('¥50.00');
    await expect(feed).toContainText('示例客户 · 出库单'); await expect(feed).toContainText('¥72.00');
    await expect(feed).toContainText('成品 B · 生产单'); await expect(feed).toContainText('100 个');
    assert.equal(await feed.locator('taro-button-core').count(), 3);
    await page.screenshot({ path: path.join(artifacts, 'reference-home-desktop.png'), fullPage: true });
    for (const width of [320, 390, 736, 1280]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1068 });
      const root = page.getByTestId('simple-workbench');
      const geometry = await root.boundingBox(); assert.ok(Math.abs(geometry.x) < 1, 'no leftover desktop sidebar width');
      assert.ok(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'no horizontal overflow');
      await page.screenshot({ path: path.join(artifacts, 'reference-home-' + width + '.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await button(page.getByTestId('workbench-actions'), '入库').click();
    await expect(page.getByText('纸板入库', { exact: true })).toBeVisible();
    await expect(page.getByText('纸箱入库', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'reference-inbound.png'), fullPage: true });
    await button(page.getByTestId('simple-workbench'), '总台').click(); await button(page.getByTestId('simple-workbench'), '收付款').click();
    await expect(page.getByText('待收款 ¥22.00', { exact: true })).toBeVisible();
    await button(page.getByTestId('simple-workbench'), '供货商账单').click();
    await expect(page.getByText('待付款 ¥211.20', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'reference-bills.png'), fullPage: true });
    await button(page.getByTestId('simple-workbench'), '总台').click();
    await button(page, '示例客户 · 收款记录').click();
    await expect(page.getByRole('dialog', { name: '流水详情' })).toBeVisible();
    assert.equal(await page.locator('body').getAttribute('data-simple-workbench-active'), null, 'legacy shell restored after navigation');
    await go(page); await button(page.getByTestId('simple-workbench'), '全部记录').click();
    await expect(page.getByText('业务记录与存根', { exact: true })).toBeVisible();
    await button(page.getByTestId('simple-workbench'), '总台').click(); await button(page.getByTestId('simple-workbench'), '成品 B · 生产单').click();
    await expect(page.getByText('领用 100 张 · 完工 100 个', { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
    console.log('PASS reference UI: four actions, three real daily records, separate inbound and bills, deep links, shell cleanup, 320/390/736/1280 widths');
  } finally {
    await Promise.all(contexts.map(c => c.close())); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
