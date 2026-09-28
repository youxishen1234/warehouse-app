const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const root = path.resolve(process.env.STOCK_FORMS_WEB_DIR || 'dist');
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const filename = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || fs.statSync(filename).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(res);
});
const apiOrigins = new Set(['http://152.136.100.200', 'https://youxishen.online']);

async function verifyLoadFailure({ origin, routeName, failedPath, submitSelector }) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    let failOnce = true;
    let failedRequests = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (apiOrigins.has(url.origin) && url.pathname.startsWith('/api/')) {
        const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization, If-Match, Idempotency-Key, X-Warehouse-Device', 'access-control-expose-headers': 'X-Warehouse-Revision' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (url.pathname === failedPath && failOnce) {
          failOnce = false;
          failedRequests += 1;
          return route.fulfill({ status: 400, contentType: 'application/json', headers, body: JSON.stringify({ success: false, message: `${routeName.toUpperCase()}_LOAD_TEST_ERROR` }) });
        }
        const data = url.pathname.endsWith('/auth/guest')
          ? { token: 'stock-form-load-test', user: { id: 'guest', username: 'guest', role: 'operator' } }
          : url.pathname.endsWith('/sync') ? { revision: 1 } : [];
        return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ success: true, data }) });
      }
      return route.abort();
    });

    await page.goto(`${origin}/#/pages/${routeName}/index`);
    await page.locator('.taro_page:visible').last().waitFor();
    const failure = `${routeName.toUpperCase()}_LOAD_TEST_ERROR`;
    const errorBlock = page.locator('[class*=error]').filter({ hasText: failure }).first();
    await errorBlock.waitFor({ state: 'visible' });
    assert.equal(failedRequests, 1, `${routeName} should surface its failed parallel request`);
    const submit = page.locator(submitSelector).first();
    assert.match(await submit.getAttribute('class') || '', /disabled/i, `${routeName} must not become ready after partial load`);
    await errorBlock.click();
    await page.locator(`[class*=error]:has-text("${failure}")`).waitFor({ state: 'detached' });
    assert.doesNotMatch(await submit.getAttribute('class') || '', /disabled/i, `${routeName} should become ready after recovery`);
    assert.deepEqual(errors, []);
    console.log(`${routeName}: parallel-load failure, no-ready guard, and retry passed`);
  } finally { await browser.close(); }
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await verifyLoadFailure({ origin, routeName: 'inbound', failedPath: '/api/delivery-notes', submitSelector: '[class*=fixedSave]' });
    await verifyLoadFailure({ origin, routeName: 'outbound', failedPath: '/api/customers', submitSelector: '[class*=btnPrimary]' });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
