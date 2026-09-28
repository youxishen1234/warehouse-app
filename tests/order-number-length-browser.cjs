const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const root = path.resolve(process.env.ORDER_LENGTH_WEB_DIR || 'dist');
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const filename = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || fs.statSync(filename).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(res);
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (url.pathname.startsWith('/api/')) {
        let data = [];
        if (url.pathname.endsWith('/auth/guest')) data = { token: 'order-number-length', user: { id: 'guest', username: 'guest', role: 'operator' } };
        else if (url.pathname.endsWith('/sync')) data = { revision: 1 };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      }
      return route.abort();
    });
    await page.goto(`${origin}/#/pages/orders/index`);
    await page.getByText('＋新增订单', { exact: true }).click();
    const orderNo = page.locator('input[placeholder="订单号"]:visible');
    await orderNo.waitFor();
    assert.equal(await orderNo.getAttribute('maxlength'), '50');
    await orderNo.fill('ORDER-' + 'A'.repeat(80));
    assert.equal((await orderNo.inputValue()).length, 50, 'order number input matches the server limit');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ orderNoMaxLength: 50, longPaste: 'capped', pageErrors: errors }));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
