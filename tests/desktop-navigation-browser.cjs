const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { serveWeb, isolateBusinessAPI, mouseDrag } = require('./tab-navigation-browser-support.cjs');

async function main() {
  const server = await serveWeb(process.env.NAV_WEB_DIR || process.env.TARO_OUTPUT_DIR || 'dist');
  const { origin } = server;
  const evidence = path.resolve(process.env.DESKTOP_NAV_EVIDENCE_DIR || 'release/desktop-navigation');
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const { writes, connections } = await isolateBusinessAPI(context, origin, { customers: 20 });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [], sizes = [];
  page.on('pageerror', error => errors.push(error.message));
  const tab = index => page.locator(`.sg-app-nav button[data-tab="${index}"]`);
  const active = () => page.locator('.taro_page:visible').last();
  const current = async route => {
    await page.waitForFunction(route => {
      const pages = [...document.querySelectorAll('.taro_page')].filter(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0);
      return location.hash.split('?')[0] === '#' + route && pages.some(el => el.id.split('?')[0] === route);
    }, '/pages/' + route + '/index');
    if (['home', 'ai-assistant', 'inventory', 'print-center', 'mine'].includes(route)) await expect(tab(['home', 'ai-assistant', 'inventory', 'print-center', 'mine'].indexOf(route))).toHaveAttribute('aria-current', 'page');
  };
  try {
    await page.goto(origin);
    for (const [index, route] of [[4, 'mine'], [0, 'home'], [2, 'inventory'], [0, 'home'], [1, 'ai-assistant'], [0, 'home'], [3, 'print-center'], [0, 'home']]) {
      await tab(index).click();
      await current(route);
    }

    for (const width of [320, 390, 736, 768, 820, 1024, 1280, 1366, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + '/#/pages/home/index');
      const workbench = page.getByTestId('simple-workbench').filter({ visible: true }).last();
      await workbench.waitFor();
      const bounds = await workbench.boundingBox();
      const dock = await page.locator('.sg-app-nav').boundingBox();
      assert.ok(bounds && dock);
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, 'page remains in the viewport: ' + JSON.stringify({ width, bounds, dock }));
      assert.ok(dock.x >= -1 && dock.x + dock.width <= width + 1 && dock.y >= -1 && dock.y + dock.height <= 901, 'navigation remains in the viewport');
      if (width >= 1024) {
        assert.ok(bounds.width > 700 && bounds.x >= dock.x + dock.width - 1, 'desktop uses the wide area beside its navigation');
        assert.ok(dock.width >= 170 && dock.width <= 240 && dock.height >= 800, 'desktop navigation is a full-height sidebar');
        const first = await tab(0).boundingBox(), last = await tab(4).boundingBox();
        assert.ok(last.y > first.y && Math.abs(last.x - first.x) < 2, 'desktop navigation items are stacked');
      } else {
        const expected = width >= 768 || width <= 500 ? width : 430;
        assert.ok(Math.abs(bounds.width - expected) <= 1 && Math.abs(bounds.x - (width - bounds.width) / 2) <= 1, 'phone and tablet use their available content width');
        assert.ok(dock.y >= 800 && dock.width <= Math.min(width, 768) + 1, 'small screens retain bottom navigation');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'layout does not overflow horizontally');
      await tab(2).click(); await current('inventory');
      const inventoryInput = page.locator('input[placeholder="搜索尺寸、货名、客户或供货商"]').filter({ visible: true }).last();
      await inventoryInput.waitFor();
      const inputBounds = await inventoryInput.boundingBox();
      assert.ok(inputBounds && inputBounds.x >= -1 && inputBounds.x + inputBounds.width <= width + 1, 'inventory search remains in the viewport: ' + JSON.stringify({ width, inputBounds }));
      await expect.poll(() => inventoryInput.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(16);
      const inputLayout = await inventoryInput.evaluate(element => {
        const input = element.getBoundingClientRect(), field = element.closest('taro-input-core').getBoundingClientRect();
        return { height: field.height, inputHeight: input.height, inputFits: input.left >= field.left && input.right <= field.right && input.top >= field.top && input.bottom <= field.bottom };
      });
      assert.ok(inputLayout.height >= 44 && inputLayout.height <= 52 && inputLayout.inputHeight >= 20 && inputLayout.inputHeight <= 28 && inputLayout.inputFits, 'inventory search text fits a stable touch-sized field: ' + JSON.stringify({ width, inputLayout }));
      await inventoryInput.fill('搜索点击检查');
      await expect(inventoryInput).toHaveValue('搜索点击检查');
      await inventoryInput.fill('');
      await tab(0).click(); await current('home');
      sizes.push({ width, page: bounds, navigation: dock, inventoryInput: inputBounds, inputLayout });
      await page.screenshot({ path: path.join(evidence, width + '-home.png') });
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
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(origin + '/#/pages/home/index');
    await page.getByTestId('workbench-business-flow').waitFor();
    await mouseDrag(page, page.getByTestId('workbench-business-flow').getByText('＋ 客户开单', { exact: true }), -130);
    await current('ai-assistant');
    assert.equal(await page.getByRole('dialog').count(), 0, 'dragging a business button must not activate its click action');
    await page.mouse.move(750, 300);
    await page.mouse.wheel(100, 0);
    await page.mouse.wheel(100, 0);
    await current('inventory');
    await page.waitForTimeout(220);
    assert.match(page.url(), /pages\/inventory\/index/, 'one trackpad burst switches one page');
    await page.mouse.wheel(-100, 0);
    await current('ai-assistant');
    await page.waitForTimeout(220);
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Shift');
    await current('inventory');
    const input = page.locator('input[placeholder="搜索尺寸、货名、客户或供货商"]');
    await input.fill('保留文字选择');
    await mouseDrag(page, input, -100);
    assert.match(page.url(), /pages\/inventory\/index/, 'text selection must not switch pages');
    assert.equal(await input.inputValue(), '保留文字选择');
    await page.goto(origin + '/#/pages/customers/index');
    await page.getByTestId('customer-management-card-20').waitFor({ state: 'attached' });
    await page.mouse.move(750, 500);
    await page.mouse.wheel(0, 350);
    await expect.poll(() => active().evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    assert.match(page.url(), /pages\/customers\/index/, 'vertical wheel scrolls a secondary page');
    await page.goto(origin + '/#/pages/home/index');
    await page.getByTestId('workbench-business-flow').waitFor();
    await active().evaluate(el => {
      const scroller = document.createElement('div');
      scroller.dataset.testid = 'gesture-native-scroll';
      scroller.style.cssText = 'width:300px;max-width:calc(100% - 40px);height:70px;overflow-x:auto;margin:20px;';
      scroller.innerHTML = '<div style="width:1200px;height:60px;background:#edf3ff">滚动区域</div>';
      el.prepend(scroller);
    });
    const horizontal = page.getByTestId('gesture-native-scroll');
    await horizontal.hover();
    await page.mouse.wheel(180, 0);
    await expect.poll(() => horizontal.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    assert.match(page.url(), /pages\/home\/index/, 'a horizontally scrollable control keeps its own gesture');
    await horizontal.evaluate(el => el.remove());
    await tab(0).focus();
    await page.keyboard.press('End'); await current('mine');
    await page.keyboard.press('Home'); await current('home');
    assert.deepEqual(writes, [], 'navigation must not write business data');
    assert.ok(connections.length > 0, 'opening printing discovers the configured computer without a business write');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ sizes, mouseDrag: 'pass', horizontalWheel: 'pass', verticalWheel: 'pass', inputSelection: 'pass', nativeHorizontalScroll: 'pass', errors, writes, printerConnections: connections.length }, null, 2));
  } finally {
    await browser.close();
    await server.close();
  }
  console.log('Desktop sidebar, wide layout, mouse drag, trackpad navigation and protected native scrolling passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
