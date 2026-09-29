// Explicit live, read-only acceptance check. Run after building dist.
// No API interception: the browser must enforce the deployed CORS policy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit } = require('@playwright/test');
const root = path.resolve('dist');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
async function check(engine, name, base) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    const failed = [];
    const pageErrors = [];
    const counts = new Map();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('requestfailed', req => {
      if (req.url().includes('/api/') && !/abort|cancel/i.test(req.failure()?.errorText || '')) failed.push({ path: new URL(req.url()).pathname, error: req.failure()?.errorText });
    });
    page.on('response', async res => {
      const url = new URL(res.url());
      if (!url.pathname.startsWith('/api/') || res.request().method() === 'OPTIONS') return;
      try {
        const body = await res.json();
        if (res.status() === 200 && body.success) counts.set(url.pathname, (counts.get(url.pathname) || 0) + 1);
      } catch { /* Ignore non-JSON responses; expected endpoints still must succeed. */ }
    });
    const waitFor = async (endpoint, count = 1) => {
      const deadline = Date.now() + 45000;
      while ((counts.get(endpoint) || 0) < count && Date.now() < deadline) await page.waitForTimeout(200);
      assert.ok((counts.get(endpoint) || 0) >= count, `${name}: ${endpoint} did not succeed; failures=${JSON.stringify(failed)}`);
    };
    await page.goto(base);
    await waitFor('/api/stats');
    await waitFor('/api/products');
    await waitFor('/api/sync', 2);
    await page.getByRole('button', { name: '入库', exact: true }).click();
    await waitFor('/api/suppliers');
    await waitFor('/api/delivery-notes');
    await page.getByRole('button', { name: '出库', exact: true }).click();
    await waitFor('/api/customers');
    await waitFor('/api/transactions');
    assert.deepEqual(failed, [], `${name}: business requests must pass browser CORS`);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ engine: name, liveCrossOrigin: 'passed', endpoints: [...counts.keys()], repeatedSync: counts.get('/api/sync'), failedRequests: failed.length }));
  } finally { await browser.close(); }
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await check(webkit, 'webkit', base);
    await check(chromium, 'chromium', base);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
