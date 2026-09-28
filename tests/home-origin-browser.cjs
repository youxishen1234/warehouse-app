const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');

async function main() {
  process.env.TEAM_PREVIEW_PORT = '0';
  const { server, db } = await require('../scripts/team-preview.cjs')();
  const base = `http://127.0.0.1:${server.address().port}`;
  const primary = 'http://152.136.100.200';
  const fallback = 'https://youxishen.online';
  const name = process.env.HOME_BROWSER === 'webkit' ? 'webkit' : 'chromium';
  const browser = await (name === 'webkit' ? webkit : chromium).launch();
  const artifactDir = path.resolve('release/home-origin-check', name);
  fs.mkdirSync(artifactDir, { recursive: true });
  const errors = [], requests = [];
  let page, failLedger = false;
  try {
    db.addProduct({ name: '跨日回归商品', unit: '件', price: 2.5, stock: 100 });
    db.addLedger({ type: 'income', amount: 7.25, remark: 'origin-download-fixture' });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Shanghai', acceptDownloads: true });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === base || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      if (![primary, fallback].includes(url.origin) || !url.pathname.startsWith('/api/')) return route.abort();
      if (route.request().method() !== 'OPTIONS') requests.push({ origin: url.origin, path: url.pathname, authenticated: !!route.request().headers().authorization });
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization, If-Match, Idempotency-Key, X-Warehouse-Device', 'access-control-expose-headers': 'X-Warehouse-Revision' };
      if (failLedger && url.origin === primary && url.pathname === '/api/ledger') {
        return route.fulfill({ status: 503, contentType: 'application/json', headers, body: JSON.stringify({ success: false, message: '测试：主线路暂时不可用' }) });
      }
      // WebKit interception cannot fulfill a 304; this suite tests origin choice,
      // while the existing backend tests cover conditional sync responses.
      const forwardedHeaders = { ...route.request().headers() };
      delete forwardedHeaders['if-none-match'];
      const response = await route.fetch({ url: base + url.pathname + url.search, headers: forwardedHeaders });
      return route.fulfill({ response, headers: { ...response.headers(), ...headers } });
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-09-30T23:59:50+08:00') });
    await page.goto(base);
    await page.getByText('9月30日 · 星期三', { exact: true }).waitFor();
    await page.getByText(/库存总值 ¥250.00$/).waitFor();
    assert(!(await page.locator('[class*="footerNote___"]').innerText()).includes('¥¥'));
    await page.locator('.team-boot').waitFor({ state: 'detached' });
    const statsCount = () => requests.filter(item => item.path === '/api/stats').length;
    const beforeMidnight = statsCount();
    await page.clock.fastForward(20000);
    await page.getByText('10月1日 · 星期四', { exact: true }).waitFor();
    await page.getByText('今天，星期四', { exact: true }).waitFor();
    await expect.poll(statsCount).toBeGreaterThan(beforeMidnight);
    await page.getByText('实时数据', { exact: true }).waitFor();

    // A cached but hidden Tab must not keep its midnight timer running.
    await page.locator('.sg-glass-tab[data-tab="3"]').click();
    await page.waitForURL(/mine/);
    await page.getByText('库存管理 · 清晰如一', { exact: true }).waitFor();
    await page.clock.runFor(500);
    const beforeHiddenTab = statsCount();
    await page.clock.fastForward(24 * 60 * 60 * 1000);
    assert.equal(statsCount(), beforeHiddenTab);
    await page.locator('.sg-glass-tab[data-tab="0"]').click();
    await page.waitForURL(/home/);
    await page.getByText('10月2日 · 星期五', { exact: true }).waitFor();
    await expect.poll(statsCount).toBeGreaterThan(beforeHiddenTab);
    await page.getByText('实时数据', { exact: true }).waitFor();

    // The page may remain mounted while the app is backgrounded overnight.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(500);
    const syncCount = () => requests.filter(item => item.path === '/api/sync').length;
    const beforeBackgroundSync = syncCount();
    const beforeBackground = statsCount();
    await page.clock.fastForward(24 * 60 * 60 * 1000);
    assert.equal(statsCount(), beforeBackground);
    assert.equal(syncCount(), beforeBackgroundSync);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.getByText('10月3日 · 星期六', { exact: true }).waitFor();
    await expect.poll(statsCount).toBeGreaterThan(beforeBackground);
    await expect.poll(syncCount).toBeGreaterThan(beforeBackgroundSync);
    await page.screenshot({ path: path.join(artifactDir, 'home.png') });

    failLedger = true;
    const start = requests.length;
    await page.getByText('流水', { exact: true }).click();
    await page.getByText(/origin-download-fixture/).waitFor();
    const ledgerReads = requests.slice(start).filter(item => item.path === '/api/ledger');
    assert.deepEqual(ledgerReads.map(item => item.origin), [primary, fallback]);
    assert(ledgerReads.every(item => item.authenticated));
    const downloaded = page.waitForEvent('download');
    await page.getByText('导出 CSV', { exact: true }).click();
    const download = await downloaded;
    const csvPath = path.join(artifactDir, 'fallback-ledger.csv');
    await download.saveAs(csvPath);
    assert.match(fs.readFileSync(csvPath, 'utf8'), /origin-download-fixture/);
    const exports = requests.filter(item => item.path === '/api/export/ledger.csv');
    assert.equal(exports.length, 1);
    assert.equal(exports[0].origin, fallback);
    assert(exports[0].authenticated);
    const beforeSync = requests.length;
    await page.clock.fastForward(4500);
    await expect.poll(() => requests.slice(beforeSync).filter(item => item.path === '/api/sync').length).toBeGreaterThan(0);
    assert(requests.slice(beforeSync).filter(item => item.path === '/api/sync').every(item => item.origin === fallback));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine: name, monthRollover: 'passed', hiddenTab: 'passed', backgroundResume: 'passed', moneySymbol: 'passed', businessFailover: 'passed', csvOriginAndToken: 'passed', syncOrigin: 'passed', pageErrors: errors }));
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(artifactDir, 'failure.png') }); console.error((await page.locator('body').innerText()).slice(0, 1000)); }
    throw error;
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
