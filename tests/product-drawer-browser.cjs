const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

const root = path.resolve(process.env.PRODUCT_DRAWER_WEB_DIR || 'dist');
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const filename = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return response.writeHead(404).end();
  response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(response);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (!url.pathname.startsWith('/api/')) return route.abort();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,X-Warehouse-Device' } });
      if (request.method() !== 'GET' && url.pathname.startsWith('/api/products')) writes.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
      const data = url.pathname.endsWith('/auth/guest')
        ? { token: 'product-drawer', user: { id: 'guest', role: 'operator' } }
        : url.pathname === '/api/products' && request.method() === 'GET' ? []
        : url.pathname === '/api/products' ? { id: 101, name: '抽屉商品', unit: '件', price: 0, stock: 0, safety_stock: 0 } : [];
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ success: true, data }) });
    });
    await page.goto(origin + '/#/pages/management/index?section=goods');
    await page.getByText('+ 新增', { exact: true }).click();
    const sheet = page.locator('[class*="editorSheet"]');
    await expect(sheet).toBeVisible();
    assert.match(await sheet.getByText('新增商品', { exact: true }).textContent(), /新增商品/);
    const naming = sheet.getByPlaceholder('请输入商品名称').locator('input');
    assert.equal(await naming.getAttribute('maxlength'), '50');
    await naming.fill('抽屉商品');
    await expect(sheet.getByText('保存商品', { exact: true })).toBeVisible();
    await sheet.getByText('保存商品', { exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(writes.length, 1, `saving from drawer sends exactly one create request: ${JSON.stringify(writes)}`);
    assert.equal(writes[0].method, 'POST');
    assert.equal(writes[0].body.name, '抽屉商品');
    assert.equal(await page.locator('[class*="editorSheet"]').count(), 0, 'drawer closes after a successful save');
    assert.deepEqual(errors, []);
    assert.ok(await page.evaluate(() => location.href.includes('/pages/management/index?section=goods')), 'product editor never navigates to the retired page');
    console.log(JSON.stringify({ drawer: 'visible', nameLimit: 50, write: writes[0].method, route: 'products' }));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
