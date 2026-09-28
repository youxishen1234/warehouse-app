const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const root = path.resolve(process.env.INBOUND_REMARK_WEB_DIR || 'dist');
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
          ? { token: 'inbound-remark-limit', user: { id: 'guest', username: 'guest', role: 'operator' } }
          : [];
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      }
      return route.abort();
    });
    await page.goto(`${origin}/#/pages/inbound/index`);
    await page.locator('.taro_page:visible').last().waitFor();
    const inputs = page.locator('input:visible');
    const remark = inputs.nth(5); // work order, driver, vehicle, operator, freight, remark
    await remark.waitFor();
    assert.equal(await remark.getAttribute('maxlength'), '500');
    await remark.fill('R'.repeat(525));
    assert.equal((await remark.inputValue()).length, 500, '送货单备注长度应与后端 500 字符上限一致');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ inboundRemarkMaxLength: 500, overLimitPaste: 'capped', pageErrors: errors }));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
