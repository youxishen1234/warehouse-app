const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-nav-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temp, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temp, 'backups');
  process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.NAV_WEB_DIR || 'dist');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const server = require('../backend/server').listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  const pendingRoutes = new Set();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    if (!url.pathname.startsWith('/api/')) return route.abort();
    const pending = (async () => {
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      await route.fulfill({ response });
    })();
    pendingRoutes.add(pending);
    try { await pending; } finally { pendingRoutes.delete(pending); }
  });
  const tab = index => page.locator(`.sg-app-nav button[data-tab="${index}"]`);
  const current = route => page.waitForFunction(route => {
    const pages = [...document.querySelectorAll('.taro_page')].filter(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0);
    return location.hash.split('?')[0] === '#' + route && pages.some(el => el.id.split('?')[0] === route);
  }, '/pages/' + route + '/index');
  try {
    await page.goto(origin);
    for (const [index, route] of [[4, 'mine'], [0, 'home'], [2, 'inventory'], [0, 'home'], [1, 'ai-assistant'], [0, 'home'], [3, 'print-center'], [0, 'home']]) {
      await tab(index).click();
      await current(route);
    }

    for (const width of [320, 390, 736, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + '/#/pages/home/index');
      await page.getByTestId('simple-workbench').filter({ visible: true }).last().waitFor();
      const bounds = await page.getByTestId('simple-workbench').filter({ visible: true }).last().boundingBox();
      assert.ok(bounds.width > 0 && bounds.width <= Math.min(width, 430) + 1, 'centered demo shell has a usable width');
      assert.ok(Math.abs(bounds.x - (width - bounds.width) / 2) <= 1, 'demo shell is centered');
      const dock = await page.locator('.sg-app-nav').boundingBox();
      assert.ok(dock.y + dock.height <= 901 && dock.width <= 431, 'five-item navigation remains in the viewport');
      await page.getByTestId('workbench-actions').filter({ visible: true }).last().getByTestId('workbench-customer-management').click();
      await current('customers');
      await page.getByTestId('customer-center').waitFor();
      await tab(0).click(); await current('home');
      await page.getByTestId('workbench-actions').filter({ visible: true }).last().locator('taro-button-core').filter({ hasText: '收付款' }).click();
      await page.getByTestId('finance-overview-view').waitFor();
      await page.getByTestId('finance-tab-ledger').click();
      await page.getByTestId('finance-ledger-view').waitFor();
      await page.goto(origin + '/#/pages/management/index?section=finance');
      await current('management');
      await page.getByTestId('finance-center').waitFor();
      assert.equal(await tab(0).getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('taro-tabbar').isVisible(), true);
      await tab(0).click(); await current('home');
    }
    await tab(0).focus();
    await page.keyboard.press('End'); await current('mine');
    await page.keyboard.press('Home'); await current('home');
    assert.deepEqual(errors, []);
  } finally {
    try {
      // Finish proxy fetches before disposing the context used by route.fetch.
      while (pendingRoutes.size) await Promise.all([...pendingRoutes]);
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await browser.close();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  console.log('Desktop tab and business navigation, responsive resize and mobile drag passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
