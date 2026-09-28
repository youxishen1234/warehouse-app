const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');

async function main() {
  process.env.TEAM_PREVIEW_PORT = '0';
  const { server, db } = await require('../scripts/team-preview.cjs')();
  const base = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.ORDER_BROWSER === 'webkit' ? 'webkit' : 'chromium';
  const browser = await (engine === 'webkit' ? webkit : chromium).launch();
  const dir = path.resolve('release/order-query-check', engine);
  fs.mkdirSync(dir, { recursive: true });
  const pageErrors = [], requests = [];
  let page;
  try {
    const statuses = ['待生产', '生产中', '已发货', '已完成', '已取消'];
    for (const [index, status] of statuses.entries()) db.addOrder({ order_no: `状态回归-${index}`, quantity: index + 1, unit_price: 2, status });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (['http://152.136.100.200', 'https://youxishen.online'].includes(url.origin) && url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/orders') requests.push({ method: request.method(), query: url.search });
        const headers = { ...request.headers() };
        delete headers['if-none-match'];
        const response = await route.fetch({ url: base + url.pathname + url.search, headers });
        return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization, If-Match, Idempotency-Key, X-Warehouse-Device', 'access-control-expose-headers': 'X-Warehouse-Revision' } });
      }
      return route.abort();
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base + '/pages/orders/index');
    const visible = text => page.getByText(text, { exact: true }).filter({ visible: true });
    const input = text => page.locator(`input[placeholder="${text}"]:visible`);
    for (const [index, status] of statuses.entries()) {
      await visible(`状态回归-${index} · 未关联客户`).waitFor();
      await visible(status).waitFor();
    }
    assert(requests.filter(request => request.method === 'GET').every(request => request.query === ''), 'the existing page must still load every status by default');
    await visible('＋新增订单').click();
    await input('订单号').fill('BROWSER-QUERY-ORDER');
    await input('数量').fill('3');
    await input('单价').fill('2.50');
    await visible('保存订单').click();
    await visible('BROWSER-QUERY-ORDER · 未关联客户').waitFor();
    await expect.poll(() => db.listOrders().find(order => order.order_no === 'BROWSER-QUERY-ORDER')?.amount).toBe(7.5);
    const card = page.locator('[class*="item___"]:visible').filter({ has: visible('BROWSER-QUERY-ORDER · 未关联客户') });
    await card.getByText('待生产', { exact: true }).click();
    const wheel = page.locator('.weui-picker__group:visible');
    // The wheel's mask receives pointer input; select one row below its center.
    await wheel.click({ position: { x: 100, y: 153 } });
    await page.getByText('确定', { exact: true }).filter({ visible: true }).click();
    await expect(card.getByText('生产中', { exact: true })).toBeVisible();
    await expect(card.getByText(/待生产 → 生产中/)).toBeVisible();
    assert.equal(db.listOrders({ status: '生产中' }).filter(order => order.order_no === 'BROWSER-QUERY-ORDER').length, 1);
    assert.equal(db.listOrders({ status: '待生产' }).filter(order => order.order_no === 'BROWSER-QUERY-ORDER').length, 0);
    await page.screenshot({ path: path.join(dir, 'orders-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(card).toBeVisible();
    await page.screenshot({ path: path.join(dir, 'orders-desktop.png'), fullPage: true });
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ engine, statuses: 5, createdAmount: 7.5, changedStatus: '生产中', widths: [390, 1280], pageErrors }));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
      fs.writeFileSync(path.join(dir, 'failure.html'), await page.content().catch(() => ''), 'utf8');
    }
    throw error;
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(path.dirname(process.env.WAREHOUSE_DATA_FILE), { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
