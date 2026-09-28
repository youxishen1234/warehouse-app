const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit } = require('@playwright/test');

const root = path.resolve(process.env.SECONDARY_WEB_DIR || 'dist');
const routes = [
  'home', 'inventory', 'products', 'records', 'ledger', 'orders',
  'carton-calculator', 'team', 'suppliers', 'product-edit', 'customers',
  'customer-edit', 'custom-copy', 'backup', 'print-center'
];

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(res);
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engineName = process.env.SECONDARY_BROWSER === 'webkit' ? 'webkit' : 'chromium';
  const engine = engineName === 'webkit' ? webkit : chromium;
  const browser = await engine.launch();
  const report = {};
  try {
    for (const routeName of routes) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const scripts = [];
      const pageErrors = [];
      const failedAssets = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin.startsWith('http://127.0.0.1') && url.pathname.endsWith('.js')) scripts.push(path.basename(url.pathname));
      });
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('response', response => {
        if (response.status() >= 400 && /\.(js|css)(\?|$)/.test(response.url())) failedAssets.push(response.url());
      });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin.startsWith('http://127.0.0.1') || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        if (url.pathname.startsWith('/api/')) {
          const data = url.pathname.endsWith('/auth/guest')
            ? { token: 'secondary-route-test', user: { id: 'guest', role: 'operator' } }
            : { items: [], total: 0, revision: 1, totalProducts: 0, totalCustomers: 0, totalSuppliers: 0, totalStock: 0, totalValue: 0, lowStock: 0, todayIn: 0, todayOut: 0 };
          return route.fulfill({ status: route.request().method() === 'OPTIONS' ? 204 : 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
        }
        return route.abort();
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/#/pages/${routeName}/index`);
      await page.waitForSelector('.taro_page', { timeout: 10000 });
      await page.waitForTimeout(400);
      report[routeName] = [...new Set(scripts)];
      assert.deepEqual(pageErrors, [], `${routeName} page errors: ${pageErrors.join('; ')}`);
      assert.deepEqual(failedAssets, [], `${routeName} failed assets: ${failedAssets.join('; ')}`);
      await context.close();
    }
    const common = new Set(report.home);
    for (const routeName of routes.slice(1)) {
      const routeChunks = report[routeName].filter(asset => !common.has(asset));
      assert.equal(routeChunks.length, 1, `${routeName} should load exactly one route chunk: ${routeChunks.join(', ')}`);
    }
    const outputDir = path.resolve('release/secondary-routes-check');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, `${engineName}.json`), JSON.stringify({ engine: engineName, routes: report }, null, 2));
    console.log(JSON.stringify({ engine: engineName, routes: routes.length, secondaryChunks: routes.length - 1, report }));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
