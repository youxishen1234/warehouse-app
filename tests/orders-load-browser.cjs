const { chromium, webkit, expect } = require('@playwright/test');

async function run(engine, label) {
  process.env.TEAM_PREVIEW_PORT = '0';
  const { server, db } = await require('../scripts/team-preview.cjs')();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const customer = db.addCustomer({ name: '订单测试客户' });
  db.addOrder({ order_no: `ORDER-${label}`, customer_id: customer.id, customer_name: customer.name, quantity: 1, unit_price: 2 });
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    let failOrders = true;
    let orderRequests = 0;
    page.on('request', request => console.log(label, request.method(), request.url()));
    page.on('response', response => { if (response.url().includes('/api/')) console.log(label, response.status(), response.url()); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      if (['http://152.136.100.200', 'https://youxishen.online'].includes(url.origin) && url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/orders') orderRequests += 1;
        if (url.pathname === '/api/orders' && failOrders) {
          return route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ success: false, message: '订单加载失败测试' }) });
        }
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
      }
      return route.abort();
    });
    await page.goto(origin + '/pages/orders/index');
    await page.waitForTimeout(3000);
    console.log('body', (await page.locator('body').innerText()).slice(0,500));
    await expect(page.getByText('订单加载失败测试 · 点击重试', { exact: true })).toBeVisible();
    await expect(page.getByText('暂无订单', { exact: true })).toHaveCount(0);
    expect(orderRequests).toBe(1);
    failOrders = false;
    await page.getByText('订单加载失败测试 · 点击重试', { exact: true }).click();
    await expect(page.getByText(`ORDER-${label} · 订单测试客户`, { exact: true })).toBeVisible();
    await expect(page.getByText('正在加载订单资料…', { exact: true })).toHaveCount(0);
    expect(orderRequests).toBe(2);
    console.log(`${label}: order error state and retry passed`);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  await run(chromium, 'chromium');
  await run(webkit, 'webkit');
})().catch(error => { console.error(error); process.exitCode = 1; });
