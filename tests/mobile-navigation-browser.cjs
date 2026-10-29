const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { serveWeb, isolateBusinessAPI, touchDrag } = require('./tab-navigation-browser-support.cjs');

const root = path.resolve(process.env.TARO_OUTPUT_DIR || 'dist');
const evidence = path.resolve(process.env.MOBILE_NAV_EVIDENCE_DIR || 'release/mobile-navigation');

async function swipe(page, dx, dy = 0) {
  const { width, height } = page.viewportSize();
  await touchDrag(page, { x: width * (dx < 0 ? .72 : .28), y: Math.min(350, height - 130), dx, dy });
}

(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const server = await serveWeb(root);
  const { origin } = server;
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const errors = [], results = [];
  try {
    for (const width of [320, 375, 390, 430]) {
      const context = await browser.newContext({ viewport: { width, height: width === 320 ? 568 : 844 }, isMobile: true, hasTouch: true });
      await context.addInitScript(() => {
        window.__sgNativeDock = { api: 2, bottomSpace: 100 };
        window.webkit = { messageHandlers: { nativeTabSelected: { postMessage: message => { window.__lastNavigationState = message; } } } };
      });
      const writes = await isolateBusinessAPI(context, origin, { customers: 20 });
      const page = await context.newPage();
      const active = () => page.locator('.taro_page:visible').last();
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
      await active().evaluate(el => { el.scrollTop = 0; });
      await swipe(page, 5, -120);
      assert.match(page.url(), /pages\/home\/index/, 'vertical gestures do not change tabs');
      await expect.poll(() => active().evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      const scroll = await active().evaluate(el => el.scrollTop);
      await active().evaluate(el => {
        el.scrollTop = 0;
        const horizontal = document.createElement('div');
        horizontal.dataset.testid = 'gesture-native-scroll';
        horizontal.style.cssText = 'width:calc(100% - 40px);height:70px;overflow-x:auto;margin:20px;touch-action:auto;';
        horizontal.innerHTML = '<div style="width:1200px;height:60px;background:#edf3ff">滚动区域</div>';
        el.prepend(horizontal);
      });
      const horizontal = page.getByTestId('gesture-native-scroll');
      await horizontal.scrollIntoViewIfNeeded();
      await expect(horizontal).toBeInViewport();
      const horizontalBox = await horizontal.boundingBox();
      await touchDrag(page, { x: horizontalBox.x + horizontalBox.width - 25, y: horizontalBox.y + 30, dx: -120 });
      await expect.poll(() => horizontal.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
      assert.match(page.url(), /pages\/home\/index/, 'native horizontal scrolling must not switch tabs');
      await horizontal.evaluate(el => el.remove());
      await page.goto(origin + '/#/pages/customers/index');
      await page.getByTestId('customer-management-card-20').waitFor({ state: 'attached' });
      await touchDrag(page, { x: width / 2, y: (width === 320 ? 568 : 844) - 160, dx: 3, dy: -180 });
      await expect.poll(() => active().evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      const customerScroll = await active().evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
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
        if (route === 'board-inbound/index') {
          const height = width === 320 ? 568 : 844;
          await page.getByText('更多信息', { exact: true }).click();
          await sheet.evaluate(el => { el.scrollTop = 0; });
          await touchDrag(page, { x: width - 6, y: height - 120, dx: 0, dy: -180 });
          await expect.poll(() => sheet.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
          await sheet.evaluate(el => { el.scrollTop = 0; });
          await swipe(page, -100);
          assert.match(page.url(), /pages\/board-inbound\/index/, 'a horizontal drag cannot discard an open business form');
          await expect(sheet).toBeVisible();
        }
        await page.screenshot({ path: path.join(evidence, width + '-' + route.split('/')[0] + '.png') });
      }
      assert.deepEqual(writes, [], 'mobile navigation must not write business data');
      results.push({ width, trustedTouch: 'pass', pageScroll: scroll, customerScroll, nativeHorizontalScroll: 'pass', formScroll: 'pass' });
      await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ results, errors }, null, 2));
    console.log('Trusted mobile touch navigation, native page/form scrolling and four business entries passed at 320/375/390/430px.');
  } finally {
    await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
