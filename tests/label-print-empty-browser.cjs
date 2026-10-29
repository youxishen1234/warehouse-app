const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

const webRoot = path.resolve(process.env.LABEL_PRINT_WEB_ROOT || 'dist');
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const filename = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(webRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return response.writeHead(404).end();
  response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(response);
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const guest = { token: 'label-empty-fixture', user: { id: 'label-reader', username: 'label-reader', role: 'viewer' } };
    await context.addInitScript(initial => localStorage.setItem('warehouse_session_v1', JSON.stringify({ data: initial })), guest);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (!url.pathname.startsWith('/api/')) return route.abort();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,X-Warehouse-Device' } });
      let data = [];
      if (url.pathname.endsWith('/auth/guest')) data = guest;
      if (url.pathname.endsWith('/sync')) data = { revision: 1 };
      if (url.pathname.endsWith('/stats')) data = { todayIn: 0, todayOut: 0, totalProducts: 0, totalStock: 0, lowStock: 0, totalValue: 0 };
      if (url.pathname.endsWith('/products')) data = { items: [], total: 0, page: 1, page_size: 12 };
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ success: true, data }) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.goto(origin + '/#/pages/management/index?section=labels&kind=finished-product');
    await page.getByText('从库存选择', { exact: true }).click();
    await page.getByText('成品标签', { exact: true }).click();
    const productLink = page.getByText('前往商品管理', { exact: true });
    await expect(page.getByText('当前共享仓库还没有商品记录。', { exact: true })).toBeVisible();
    await expect(productLink).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'product empty state has no horizontal overflow');
    await productLink.click();
    await page.waitForURL(/pages\/management\/index\?section=goods/);

    await page.close();
    const boardPage = await context.newPage();
    boardPage.setDefaultTimeout(12000);
    boardPage.on('pageerror', error => errors.push(error.message));
    await boardPage.goto(origin + '/#/pages/management/index?section=labels&kind=paperboard-batch');
    await boardPage.getByText('从库存选择', { exact: true }).click();
    const boardLink = boardPage.getByText('新增纸板批次', { exact: true });
    await expect(boardPage.getByText('当前共享仓库还没有纸板批次记录。', { exact: true })).toBeVisible();
    await expect(boardLink).toBeVisible();
    await boardLink.click();
    await boardPage.waitForURL(/pages\/board-inbound\/index/);
    assert.deepEqual(errors, [], 'no runtime errors');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
