const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, expect } = require('@playwright/test');

const root = path.resolve(process.env.TARO_OUTPUT_DIR || 'dist');
const evidence = path.resolve(process.env.MOBILE_NAV_EVIDENCE_DIR || 'release/mobile-navigation');
const server = http.createServer((req, res) => {
  const name = path.resolve(root, '.' + (new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname));
  if (!name.startsWith(root + path.sep) || !fs.existsSync(name) || fs.statSync(name).isDirectory()) return res.writeHead(404).end();
  res.setHeader('content-type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(name)] || 'application/octet-stream');
  fs.createReadStream(name).pipe(res);
});

async function swipe(page, dx, dy = 0) {
  await page.evaluate(({ dx, dy }) => {
    const active = [...document.querySelectorAll('.taro_page')].reverse().find(el => getComputedStyle(el).display !== 'none');
    const target = active.querySelector('[data-testid="workbench-actions"] taro-button-core') || active;
    for (const [type, x, y, ended] of [['touchstart', 160, 350, false], ['touchmove', 160 + dx, 350 + dy, false], ['touchend', 160 + dx, 350 + dy, true]]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: ended ? [] : [{ clientX: x, clientY: y }] }, changedTouches: { value: [{ clientX: x, clientY: y }] } });
      target.dispatchEvent(event);
    }
  }, { dx, dy });
}

(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const errors = [];
  try {
    for (const width of [320, 375, 390, 430]) {
      const context = await browser.newContext({ viewport: { width, height: width === 320 ? 568 : 844 }, isMobile: true, hasTouch: true });
      await context.addInitScript(() => {
        window.__sgNativeDock = { api: 2, bottomSpace: 100 };
        window.webkit = { messageHandlers: { nativeTabSelected: { postMessage: message => { window.__lastNavigationState = message; } } } };
      });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort();
        let data = [];
        if (url.pathname.endsWith('/auth/guest')) data = { token: 'mobile-test', user: { id: 1, username: 'test', role: 'viewer' } };
        if (url.pathname === '/api/customers') data = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `手机滚动验收-${i + 1}`, debt: 0, specs: [] }));
        if (url.pathname.endsWith('/sync')) data = { revision: 1 };
        if (url.pathname.endsWith('/stats')) data = { todayIn: 0, todayOut: 0, totalProducts: 0, totalStock: 0, lowStock: 0, totalValue: 0 };
        if (url.pathname.includes('dimensions')) data = { customers: [], schemaVersion: 1, revision: 0, theme: {} };
        if (url.pathname.endsWith('/print-notes')) data = { items: [], total: 0, page: 1, page_size: 30 };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/#/pages/home/index');
      await page.locator('.sg-app-nav button[data-tab="2"]').waitFor();
      await expect.poll(() => page.evaluate(() => window.__lastNavigationState?.presentation)).toBe('web');
      assert.equal(await page.evaluate(() => window.__lastNavigationState.ready), false, 'installed native dock must be hidden');
      for (const [index, name] of [[2, 'inventory'], [3, 'print-center'], [4, 'mine'], [0, 'home']]) {
        await page.locator(`.sg-app-nav button[data-tab="${index}"]`).click();
        await page.waitForURL(new RegExp('/pages/' + name + '/index'));
        await expect(page.locator(`.sg-app-nav button[data-tab="${index}"]`)).toHaveAttribute('aria-current', 'page');
        await expect.poll(() => page.evaluate(() => window.__lastNavigationState?.route)).toBe('/pages/' + name + '/index');
      }
      await swipe(page, -100);
      await page.waitForURL(/pages\/ai-assistant\/index/);
      await expect(page.locator('.sg-app-nav button[data-tab="1"]')).toHaveAttribute('aria-current', 'page');
      await expect.poll(() => page.evaluate(() => window.__lastNavigationState?.route)).toBe('/pages/ai-assistant/index');
      await swipe(page, -100);
      await page.waitForURL(/pages\/inventory\/index/);
      await expect(page.locator('.sg-app-nav button[data-tab="2"]')).toHaveAttribute('aria-current', 'page');
      await expect.poll(() => page.evaluate(() => window.__lastNavigationState?.route)).toBe('/pages/inventory/index');
      await swipe(page, 100);
      await page.waitForURL(/pages\/ai-assistant\/index/);
      await expect(page.locator('.sg-app-nav button[data-tab="1"]')).toHaveAttribute('aria-current', 'page');
      await expect.poll(() => page.evaluate(() => window.__lastNavigationState?.route)).toBe('/pages/ai-assistant/index');
      await page.locator('.sg-app-nav button[data-tab="0"]').click();
      await page.waitForURL(/pages\/home\/index/);
      await swipe(page, 5, -120);
      assert.match(page.url(), /pages\/home\/index/, 'vertical gestures do not change tabs');
      const scroll = await page.locator('.taro_page:visible').last().evaluate(el => { el.scrollTop = 150; return el.scrollTop; });
      if (width === 320) assert.ok(scroll > 0, 'short phone can scroll the full page');
      await page.goto(origin + '/#/pages/customers/index');
      await page.getByTestId('customer-management-card-20').waitFor({ state: 'attached' });
      const customerScroll = await page.locator('.taro_page:visible').last().evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
      assert.ok(customerScroll > 0, 'non-tab customer page scrolls vertically');
      await expect(page.getByTestId('customer-management-card-20')).toBeInViewport();
      for (const route of ['customer-orders/index?create=1', 'board-inbound/index', 'carton-inbound/index', 'production-inbound/index']) {
        await page.goto(origin + '/#/pages/' + route);
        const sheet = page.getByTestId(({ 'customer-orders': 'customer-order-sheet', 'board-inbound': 'paperboard-receipt-sheet', 'carton-inbound': 'carton-receipt-sheet', 'production-inbound': 'production-receipt-sheet' })[route.split('/')[0]]);
        await sheet.waitFor();
        await expect(sheet).toBeVisible();
        const geometry = await sheet.boundingBox();
        assert.ok(geometry, `${width}px ${route}: modal has no visible bounds at ${page.url()}`);
        assert.ok(geometry.x >= -1 && geometry.x + geometry.width <= width + 1, JSON.stringify(geometry));
        assert.ok(geometry.y >= 0 && geometry.y + geometry.height <= (width === 320 ? 568 : 844) + 1);
        const overflow = await page.evaluate(() => [...document.querySelectorAll('.demo-field input')].filter(el => el.getClientRects().length).some(el => el.getBoundingClientRect().right > innerWidth + 1));
        assert.equal(overflow, false, route);
        await page.screenshot({ path: path.join(evidence, width + '-' + route.split('/')[0] + '.png') });
      }
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log('Mobile navigation, gestures, scrolling and four new business entries passed at 320/375/390/430px.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
