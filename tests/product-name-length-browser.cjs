const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const root = path.resolve(process.env.PRODUCT_EDIT_WEB_DIR || 'dist');
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
        const data = url.pathname.endsWith('/auth/guest')
          ? { token: 'product-name-limit', user: { id: 'guest', username: 'guest', role: 'operator' } }
          : { items: [], total: 0, revision: 1 };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      }
      return route.abort();
    });
    await page.goto(`${origin}/#/pages/product-edit/index`);
    const fields = page.locator('input:visible');
    const limits = [50, 100, 100, 50, 100]; // name, specification, material, category, corrugation
    for (let index = 0; index < limits.length; index++) {
      const field = fields.nth(index);
      await field.waitFor();
      assert.equal(await field.getAttribute('maxlength'), String(limits[index]));
      await field.fill('A'.repeat(limits[index] + 25));
      assert.equal((await field.inputValue()).length, limits[index], `field ${index} should match backend length limit`);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ textFieldLimits: limits, longPaste: 'capped', pageErrors: errors }));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
