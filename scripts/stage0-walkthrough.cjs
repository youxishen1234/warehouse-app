'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('../backend/node_modules/express');
const { chromium } = require('playwright');
const { capture, restore } = require('./stage0-snapshot.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'release/stage0');
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-stage0-walkthrough-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(isolated, 'data.json');
  process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(isolated, 'accounts.json');
  process.env.WAREHOUSE_GATE_PASSWORD_FILE = path.join(isolated, 'access-password');
  const fixture = { products: [], customers: [], suppliers: [], transactions: [], ledger: [], orders: [], _meta: { nextProductId: 1, nextCustomerId: 1, nextSupplierId: 1, nextTransactionId: 1, nextLedgerId: 1 } };
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify(fixture, null, 2));
  const drill = fs.mkdtempSync(path.join(output, 'fixture-drill-'));
  capture(process.env.WAREHOUSE_DATA_FILE, path.join(drill, 'snapshot'), undefined, true);
  const recovery = restore(path.join(drill, 'snapshot'), path.join(drill, 'restored'));
  fs.writeFileSync(path.join(drill, 'result.json'), JSON.stringify({ ...recovery, productionBackup: false }, null, 2));
  const install = require('../backend/team');
  await install.bootstrap(process.env.WAREHOUSE_ACCOUNTS_FILE, 'Stage0-isolated-fixture-only!');
  const db = require('../backend/db');
  const app = express(); app.use(express.json());
  app.use('/api', install(db));
  const assets = path.join(output, 'h5');
  app.use(express.static(assets));
  app.get('*', (req, res) => res.sendFile(path.join(assets, 'index.html')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const results = [];
  try {
    const health = await fetch(base + '/api/health');
    fs.writeFileSync(path.join(output, 'health.json'), JSON.stringify({ status: health.status, body: await health.json(), fixture: true }, null, 2));
    browser = await chromium.launch();
    const source = fs.readFileSync(path.join(root, 'src/app.config.ts'), 'utf8');
    const routes = [...new Set(source.split('window:')[0].match(new RegExp('pages/[a-z-]+/index', 'g')))];
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, serviceWorkers: 'block' });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === base) return route.continue();
        if (url.pathname.startsWith('/api/')) {
          const response = await route.fetch({ url: base + url.pathname + url.search });
          return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Warehouse-Revision' } });
        }
        return route.abort('blockedbyclient');
      });
      for (const name of routes) {
        const page = await context.newPage();
        const row = { route: name, width, fixture: 'empty', jsErrors: [], consoleErrors: [], failedRequests: [], non2xx: [] };
        const cleanUrl = value => { const url = new URL(value); return url.origin + url.pathname; };
        page.on('pageerror', error => row.jsErrors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') row.consoleErrors.push(message.text()); });
        page.on('requestfailed', request => row.failedRequests.push({ url: cleanUrl(request.url()), reason: request.failure()?.errorText }));
        page.on('response', response => { if (response.status() < 200 || response.status() >= 300) row.non2xx.push({ url: cleanUrl(response.url()), status: response.status() }); });
        try {
          await page.goto(base + '/#/' + name, { waitUntil: 'networkidle', timeout: 20000 });
          await page.waitForTimeout(350);
          row.layout = await page.evaluate(() => {
            const visible = [...document.querySelectorAll('.taro_page')].filter(x => getComputedStyle(x).display !== 'none' && x.getBoundingClientRect().height > 0);
            const current = visible.at(-1);
            return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, contentWidth: current?.getBoundingClientRect().width || 0, textLength: current?.textContent?.trim().length || 0, url: location.hash };
          });
          row.blank = row.layout.textLength === 0;
          row.screenshot = name.split('/')[1] + '-' + width + '.png';
          await page.screenshot({ path: path.join(output, row.screenshot), fullPage: true });
        } catch (error) { row.error = error.message; }
        results.push(row);
        await page.close();
      }
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(output, 'walkthrough.json'), JSON.stringify({ fixtureOnly: true, productionDataUsed: false, results }, null, 2));
  }
  console.log(JSON.stringify({ routesCaptured: results.length, issueRoutes: results.filter(x => x.error || x.blank || x.jsErrors.length || x.consoleErrors.length || x.failedRequests.length || x.non2xx.length).length, report: 'release/stage0/walkthrough.json' }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
