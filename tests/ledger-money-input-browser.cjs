const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const root = path.resolve(process.env.LEDGER_WEB_DIR || 'dist');
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
        let data = {};
        if (url.pathname.endsWith('/auth/guest')) data = { token: 'ledger-amount-input', user: { id: 'guest', username: 'guest', role: 'operator' } };
        else if (url.pathname.endsWith('/ledger') && route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          data = { id: 1, created_at: Date.now(), ...body };
        } else if (url.pathname.endsWith('/ledger')) data = [];
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      }
      return route.abort();
    });
    await page.goto(`${origin}/#/pages/ledger/index`);
    await page.locator('.taro_page:visible').last().waitFor();
    await page.getByText('\u002b \u65b0\u589e\u6d41\u6c34', { exact: true }).click();
    const amount = page.locator('input:visible').first();
    await amount.fill('12.345');
    assert.equal(await amount.inputValue(), '12.34');
    await amount.fill('-30');
    assert.equal(await amount.inputValue(), '');
    await amount.fill('2e3');
    assert.equal(await amount.inputValue(), '');
    await amount.fill('99999999999');
    assert.equal(await amount.inputValue(), '');
    await amount.fill('12.345');
    assert.equal(await amount.inputValue(), '12.34');
    const preview = page.locator('[class*=remark]').filter({ hasText: /12\.34/ }).last();
    await preview.waitFor({ state: 'visible' });
    assert.match(await preview.innerText(), /12\.34/, 'preview shows the shared rounded amount');
    const writePromise = page.waitForRequest(request => new URL(request.url()).pathname === '/api/ledger' && request.method() === 'POST');
    await page.getByText('\u4fdd\u5b58\u6d41\u6c34', { exact: true }).click();
    const write = await writePromise;
    const postedAmount = write.postDataJSON().amount;
    assert.equal(postedAmount, 12.34, 'submitted ledger amount must equal the preview amount');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ centsPrecision: 'passed', previewMatchesWrite: postedAmount, negativeInput: 'rejected', exponentInput: 'rejected', amountLimit: 'rejected', pageErrors: errors }));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
