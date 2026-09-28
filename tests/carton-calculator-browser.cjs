const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

const root = path.resolve(process.env.CARTON_WEB_DIR || 'dist');
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filename = path.resolve(root, `.${requested}`);
  if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || fs.statSync(filename).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(res);
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === `http://127.0.0.1:${server.address().port}` || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (url.pathname.startsWith('/api/')) {
        const data = url.pathname.endsWith('/auth/guest')
          ? { token: 'carton-preview-test', user: { id: 'guest', role: 'operator' } }
          : { items: [], total: 0, revision: 1 };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      }
      return route.abort();
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/#/pages/carton-calculator/index`);
    await page.locator('.taro_page:visible').last().waitFor();
    const inputs = page.locator('input:visible');
    assert.equal(await inputs.count(), 4, 'length, width, height and thickness inputs render');
    await inputs.nth(0).fill('100');
    await inputs.nth(1).fill('80');
    await inputs.nth(2).fill('50');
    await inputs.nth(3).fill('3');

    await page.getByText('内尺寸', { exact: true }).click();
    let result = await page.locator('[class*=resultGrid]').innerText();
    assert.match(result, /106/);
    assert.match(result, /86/);
    assert.match(result, /56/);

    await page.getByText('外尺寸', { exact: true }).click();
    result = await page.locator('[class*=resultGrid]').innerText();
    assert.match(result, /94/);
    assert.match(result, /74/);
    assert.match(result, /44/);

    await inputs.nth(0).fill('5');
    await expect(page.getByText(/外尺寸必须大于两倍瓦楞厚度/)).toBeVisible();
    await expect(page.locator('[class*=resultGrid]')).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ innerToOuter: 'passed', outerToInner: 'passed', invalidOuterBoundary: 'passed', pageErrors: errors }));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
