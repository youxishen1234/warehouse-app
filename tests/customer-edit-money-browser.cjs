const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const root = path.resolve(process.env.CUSTOMER_EDIT_WEB_DIR || 'dist');
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
          ? { token: 'customer-input-browser', user: { id: 'guest', username: 'guest', role: 'operator' } }
          : {};
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      }
      return route.abort();
    });
    await page.goto(`${origin}/#/pages/customer-edit/index?party=customer`);
    await page.locator('.taro_page:visible').last().waitFor();
    const amount = page.locator('input:visible').last();
    await amount.fill('12.345');
    assert.equal(await amount.inputValue(), '12.34', 'balance precision is capped at cents while typing');
    await amount.fill('-50');
    assert.equal(await amount.inputValue(), '', 'negative paste is rejected instead of becoming positive debt');
    await amount.fill('1e5');
    assert.equal(await amount.inputValue(), '', 'scientific notation is rejected instead of becoming a different amount');
    await amount.fill('99999999999');
    assert.equal(await amount.inputValue(), '', 'amount outside the supported numeric range is rejected');

    const textInputs = page.locator('input:visible');
    const fieldLimits = [50, 50, 20, 200];
    for (let index = 0; index < fieldLimits.length; index++) {
      const field = textInputs.nth(index);
      assert.equal(await field.getAttribute('maxlength'), String(fieldLimits[index]));
      const longValue = index === 2 ? '1'.repeat(fieldLimits[index] + 25) : 'A'.repeat(fieldLimits[index] + 25);
      await field.fill(longValue);
      assert.equal((await field.inputValue()).length, fieldLimits[index]);
    }
    const remark = page.locator('textarea:visible').first();
    assert.equal(await remark.getAttribute('maxlength'), '500');
    await remark.fill('B'.repeat(525));
    assert.equal((await remark.inputValue()).length, 500);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ moneyPrecision: 'passed', negativePaste: 'passed', exponentPaste: 'passed', amountLimit: 'passed', textLengthLimits: fieldLimits, remarkMaxLength: 500, pageErrors: errors }));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

