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
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    if (!url.pathname.startsWith('/api/')) return route.abort();
    const response = await route.fetch({ url: origin + url.pathname + url.search });
    return route.fulfill({ response });
  });
  const tab = index => page.locator(`.sg-glass-items button[data-tab="${index}"]`);
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
    assert.equal(await page.locator('.sg-glass-items').evaluate(el => getComputedStyle(el).maskImage), 'none');
    for (const name of ['inventory', 'customers', 'orders', 'print-center']) {
      await page.locator(`button[data-nav="/pages/${name}/index"]`).click();
      if (name === 'customers') {
        await current('customers');
        await page.getByTestId('simple-workbench').last().waitFor();
      } else await current(name);
      await page.goto(origin);
      await current('home');
    }
    await page.locator('button[data-nav]').filter({ hasText: '账单中心' }).click();
    await current('business-center');
    await page.getByTestId('finance-center').filter({ visible: true }).last().waitFor();
    await page.getByTestId('finance-ledger-view').filter({ visible: true }).last().waitFor();
    assert.equal(await page.locator('taro-tabbar').isVisible(), true, 'business center keeps the shared liquid dock');
    assert.equal(await tab(0).getAttribute('aria-current'), 'page', 'business center selects the home tab');
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-tab-context')), true);
    await tab(0).click();
    await current('home');
    // Retired ledger deep links remain compatible and land in the unified finance tab.
    await page.goto(origin + '/#/pages/ledger/index');
    await current('business-center');
    await page.getByTestId('finance-center').filter({ visible: true }).last().waitFor();
    await page.getByTestId('finance-ledger-view').filter({ visible: true }).last().waitFor();
    // Resizing restores the mobile lens and preserves its drag-to-select behavior.
    await page.goto(origin + '/#/pages/mine/index');
    await current('mine');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sg-glass-lens')).display !== 'none');
    await tab(3).click();
    await current('print-center');
    const first = await tab(0).boundingBox(), last = await tab(4).boundingBox();
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 12 });
    assert.match(page.url(), /print-center/);
    await page.mouse.up();
    await current('mine');
    assert.deepEqual(errors, []);
  } finally {
    try {
      // Finish proxy fetches before disposing the context used by route.fetch.
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
