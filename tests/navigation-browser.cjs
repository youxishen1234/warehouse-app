const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('@playwright/test');

const root = path.resolve(process.env.NAV_WEB_DIR || 'dist');
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(res);
});

async function swipe(page, dx, options = {}) {
  return page.evaluate(({ dx, options }) => {
    const active = Array.from(document.querySelectorAll('.taro_page')).reverse().find(p => getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().height > 0);
    const target = options.target ? active.querySelector(options.target) : active;
    if (!target) throw new Error('Missing swipe target: ' + options.target);
    const x = options.x || innerWidth / 2, y = 300;
    function dispatch(type, x2, y2, ended) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: ended ? [] : [{ clientX: x2, clientY: y2 }] });
      Object.defineProperty(event, 'changedTouches', { value: [{ clientX: x2, clientY: y2 }] });
      target.dispatchEvent(event);
    }
    dispatch('touchstart', x, y);
    dispatch('touchmove', x + dx, y + (options.dy || 0));
    const moving = getComputedStyle(target).transform;
    dispatch(options.cancel ? 'touchcancel' : 'touchend', x + dx, y, true);
    return moving;
  }, { dx, options });
}

async function verify(browser, name) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await page.route(/\/api\//, route => {
    const url = new URL(route.request().url());
    let data = [];
    if (url.pathname.endsWith('/auth/guest')) data = { token: 'test-token', user: { id: '1', username: 'preview', role: 'viewer' } };
    if (url.pathname.endsWith('/stats')) data = { todayIn: 0, todayOut: 0, totalProducts: 0, totalStock: 0, lowStock: 0, totalValue: 0 };
    if (url.pathname.endsWith('/sync')) data = { revision: 1 };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
  });
  await page.goto(origin);
  await page.waitForSelector('.sg-glass-tab[data-tab]');
  const workbench = page.locator('[data-testid="simple-workbench"]:visible').first();
  await workbench.locator('[data-testid="workbench-actions"] > taro-button-core').first().waitFor();
  assert.equal(await workbench.locator('[data-testid="workbench-actions"] > taro-button-core').count(), 4);
  const before = await page.locator('taro-tabbar').boundingBox();
  assert.ok(before.y > 700 && before.y + before.height <= 845, JSON.stringify(before));
  assert.equal(await page.locator('.sg-glass-tab[data-tab]').count(), 5);
  assert.equal(await page.locator('.sg-glass-search').count(), 0, 'no search button');
  assert.deepEqual(await page.locator('.sg-glass-tab[data-tab] span').allTextContents(), ['总台', 'AI助手', '库存', '打印', '我的']);
  assert.ok(Math.abs((await page.locator('.sg-glass-rail').boundingBox()).width - (await page.locator('.sg-glass-dock').boundingBox()).width) < 1, 'five tabs fill the dock with no search gap');
  assert.equal(await page.locator('.weui-tabbar').isVisible(), false, 'old rectangular dock is replaced');
  const colors = await page.evaluate(() => ({
    normal: getComputedStyle(document.querySelector('.sg-glass-items')).color,
    selected: getComputedStyle(document.querySelector('.sg-glass-lens')).color,
    glass: getComputedStyle(document.querySelector('.sg-glass-rail')).backgroundColor
  }));
  assert.notEqual(colors.normal, colors.selected, 'dock labels and selected labels use distinct colors');
  assert.ok(colors.glass && colors.glass !== 'rgba(0, 0, 0, 0)', 'dock keeps an opaque liquid backing');
  await page.screenshot({ path: 'release/glass-' + name + '-rest.png' });
  await page.goto(origin + '/#/pages/business-center/index');
  const businessWorkbench = page.locator('[data-testid="simple-workbench"][data-tab-route="/pages/home/index"]:visible').first();
  await businessWorkbench.locator('[data-testid="workbench-actions"] > taro-button-core').first().waitFor();
  const businessState = await page.evaluate(() => ({
    context: document.documentElement.hasAttribute('data-tab-context'),
    route: location.hash,
    pages: Array.from(document.querySelectorAll('.taro_page')).map(page => ({
      id: page.id,
      display: getComputedStyle(page).display,
      width: page.getBoundingClientRect().width,
      classes: page.className,
      owner: page.getAttribute('data-tab-route')
        || page.querySelector('[data-tab-route]')?.getAttribute('data-tab-route')
    }))
  }));
  assert.equal(businessState.context, true, 'business center restores the main-tab context: ' + JSON.stringify(businessState));
  assert.equal(await page.locator('.sg-glass-tab[data-tab="0"]').getAttribute('aria-current'), 'page', 'business center belongs to the home tab');
  assert.equal(await page.locator('taro-tabbar').isVisible(), true, 'business center keeps the shared liquid dock');
  assert.notEqual(await swipe(page, 110), 'none', 'business-center page swipe back to home follows the finger');
  await page.waitForURL(/home/);
  await page.goto(origin + '/#/pages/business-center/index');
  await businessWorkbench.locator('[data-testid="workbench-actions"] > taro-button-core').first().waitFor();
  assert.notEqual(await swipe(page, -110), 'none', 'business-center page swipe follows the finger');
  await page.waitForURL(/ai-assistant/);
  await page.waitForTimeout(500);
  await page.locator('.sg-glass-tab[data-tab="0"]').click();
  await page.waitForURL(/home/);
  await page.waitForTimeout(500);
  const restingLens = await page.locator('.sg-glass-lens').boundingBox();
  const railBounds = await page.locator('.sg-glass-rail').boundingBox();
  async function assertStableLens() {
    const lens = await page.locator('.sg-glass-lens').boundingBox();
    assert.ok(Math.abs(lens.width - restingLens.width) < .1, 'drag does not stretch the capsule');
    assert.ok(Math.abs(lens.height - restingLens.height) < .1, 'drag does not inflate the capsule');
    assert.ok(lens.y >= railBounds.y + 3.9 && lens.y + lens.height <= railBounds.y + railBounds.height - 3.9, 'capsule never protrudes');
  }
  const first = await page.locator('.sg-glass-tab[data-tab="0"]').boundingBox();
  const last = await page.locator('.sg-glass-tab[data-tab="4"]').boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await assertStableLens();
  const midway = first.x + first.width * 1.85;
  await page.mouse.move(midway, first.y + first.height / 2, { steps: 8 });
  const progress = Number(await page.locator('.sg-glass-dock').getAttribute('data-position'));
  assert.ok(progress > 1.2 && progress < 1.5, 'lens follows continuous finger position: ' + progress);
  assert.equal(await page.locator('.sg-glass-dock').evaluate(el => el.classList.contains('sg-glass-pressed')), true);
  await assertStableLens();
  assert.equal(await page.locator('.sg-glass-lens-ink').evaluate(el => getComputedStyle(el).filter), 'none', 'icons are not distorted');
  assert.match(page.url(), /home/, 'drag previews without navigating until release');
  await page.screenshot({ path: 'release/glass-' + name + '-drag.png' });
  await page.locator('.sg-glass-tab[data-tab="2"] span').waitFor();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 12 });
  await assertStableLens();
  await page.mouse.up();
  await page.waitForURL(/mine/);
  await page.waitForFunction(() => document.querySelector('[data-tab="4"]').getAttribute('aria-current') === 'page');
  await page.locator('.sg-glass-tab[data-tab="0"]').click();
  await page.waitForURL(/home/);
  await page.waitForTimeout(400);
  if (name === 'chromium') {
    const touch = await page.context().newCDPSession(page);
    const point = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: point.x + first.width * 3.35 }] });
    assert.ok(Number(await page.locator('.sg-glass-dock').getAttribute('data-position')) > 3.2, 'real touch follows the dock, not the page swipe handler');
    assert.match(page.url(), /home/);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForURL(/print-center/);
    await page.locator('.sg-glass-tab[data-tab="0"]').click();
    await page.waitForURL(/home/);
    await touch.detach();
    await page.waitForTimeout(400);
  }
  // Cancelled capture restores the acknowledged tab, including after crossing cells.
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x, last.y + last.height / 2);
  await page.locator('.sg-glass-rail').evaluate(rail => rail.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
  await page.mouse.up();
  await page.waitForTimeout(450);
  assert.match(page.url(), /home/);
  await page.waitForFunction(() => Math.abs(Number(document.querySelector('.sg-glass-dock').dataset.position)) < .001);
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x, first.y - 80, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  assert.match(page.url(), /home/, 'leaving the dock vertically cancels the pending selection');
  await page.waitForFunction(() => Math.abs(Number(document.querySelector('.sg-glass-dock').dataset.position)) < .001);
  assert.notEqual(await swipe(page, -110), 'none', 'gesture follows finger');
  await page.waitForURL(/ai-assistant/);
  await page.waitForTimeout(500);
  await swipe(page, -110);
  await page.waitForURL(/inventory/);
  await page.waitForTimeout(500);
  await page.locator('.taro_page:visible').last().getByTestId('simple-workbench').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-tab="2"]').getAttribute('aria-current') === 'page');
  for (const target of ['input']) {
    await swipe(page, -110, { target });
    await page.waitForTimeout(250);
    assert.match(page.url(), /inventory/, 'interactive stock controls do not switch tabs: ' + target);
  }
  await page.getByText('新增入库', { exact: true }).click();
  await page.locator('taro-button-core').filter({ hasText: '纸板入库' }).click();
  await page.waitForURL(/board-receive/);
  await page.waitForTimeout(500);
  await swipe(page, 120, { x: 20 });
  await page.waitForURL(/inventory/);
  await page.waitForTimeout(500);
  await page.locator('.taro_page:visible').last().getByTestId('simple-workbench').waitFor();
  await page.setViewportSize({ width: 320, height: 740 });
  const stockLabel = page.locator('.sg-glass-tab[data-tab="2"] span');
  assert.equal(await stockLabel.innerText(), '库存');
  assert.ok(await stockLabel.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().height < 20), 'stock label fits on one line at 320px');
  await page.screenshot({ path: 'release/board-dock-' + name + '-320.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await swipe(page, -110);
  await page.waitForURL(/print-center/);
  await page.waitForTimeout(500);
  await swipe(page, -110);
  await page.waitForURL(/mine/);
  await page.waitForTimeout(500);
  await swipe(page, 110, { x: 20 });
  await page.waitForTimeout(250);
  assert.match(page.url(), /mine/, '50px edges reserved');
  await swipe(page, 110, { dy: 180 });
  await page.waitForTimeout(250);
  assert.match(page.url(), /mine/, 'vertical scroll does not switch');
  await swipe(page, 110, { cancel: true });
  await page.waitForTimeout(250);
  assert.match(page.url(), /mine/, 'cancel does not switch');
  await page.evaluate(() => {
    window.__nativeMessages = [];
    window.webkit = { messageHandlers: { nativeTabSelected: { postMessage: s => window.__nativeMessages.push(s) } } };
    window.__sgNativeDock = { api: 2, version: '1.0.7', build: '96', bottomSpace: 84 };
    window.dispatchEvent(new Event('sg-native-ready'));
  });
  await page.waitForFunction(() => document.documentElement.classList.contains('sg-native-ios'));
  assert.equal(await page.locator('taro-tabbar').isVisible(), false, 'hide web fallback only after native handshake');
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--sg-native-bottom-space')), '84px');
  for (const bottomSpace of [0, null, 0]) {
    await page.evaluate(bottomSpace => {
      window.__sgNativeDock = { ...window.__sgNativeDock, bottomSpace, layout: 'inset' };
      window.dispatchEvent(new Event('sg-native-ready'));
    }, bottomSpace);
    await page.waitForFunction(expected => document.documentElement.style.getPropertyValue('--sg-native-bottom-space') === expected, bottomSpace === null ? '84px' : '0px');
  }
  await swipe(page, 110);
  await page.waitForURL(/print-center/);
  for (const route of ['/pages/inventory/index', '/pages/ai-assistant/index', '/pages/print-center/index', '/pages/mine/index', '/pages/home/index']) {
    await page.evaluate(route => window.dispatchEvent(new CustomEvent('sg-native-tab', { detail: route })), route);
    await page.waitForURL(new RegExp(route));
    await page.waitForTimeout(500);
    await page.waitForFunction(route => window.__nativeMessages.at(-1)?.route === route, route);
  }
  const pageText = await page.locator('body').innerText();
  // Native selection may arrive again before Taro finishes the previous one.
  // The last finger destination must win, with no old-route acknowledgment.
  await page.evaluate(() => {
    window.__nativeMessages = [];
    ['/pages/inventory/index', '/pages/ai-assistant/index', '/pages/print-center/index', '/pages/mine/index'].forEach((route, index) => {
      const event = new CustomEvent('sg-native-tab', { detail: route });
      event.requestId = 201 + index;
      window.dispatchEvent(event);
    });
  });
  await page.waitForURL(/mine/);
  await page.waitForFunction(() => window.__nativeMessages.at(-1)?.requestId === 204);
  const acknowledgments = await page.evaluate(() => window.__nativeMessages);
  assert.ok(acknowledgments.length > 0);
  assert.ok(acknowledgments.every(s => s.route === '/pages/mine/index' && s.requestId === 204), JSON.stringify(acknowledgments));
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) { const item = document.createElement('span'); document.body.appendChild(item); item.remove(); }
  });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__nativeMessages.length), acknowledgments.length, 'unrelated DOM changes do not resend the selection');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('sg-native-tab', { detail: '/pages/home/index' })));
  await page.waitForURL(/home/);
  for (const label of ['入库', '生产', '出库', '账单中心', '今天的记录']) assert.ok(pageText.includes(label), `homepage action missing: ${label}`);
  await page.evaluate(() => {
    delete window.__sgNativeDock;
    window.dispatchEvent(new Event('sg-native-ready'));
  });
  await page.waitForFunction(() => !document.documentElement.classList.contains('sg-native-ios'));
  await page.evaluate(() => {
    window.__sgNativeDock = { api: 0, material: 'web-glass' };
    window.dispatchEvent(new Event('sg-native-ready'));
  });
  await page.waitForFunction(() => window.__nativeMessages.at(-1)?.ready === true);
  assert.equal(await page.locator('.sg-glass-dock').isVisible(), true, 'older iOS keeps the web glass dock');
  await page.locator('[data-tab="0"]').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForURL(/ai-assistant/);
  await page.keyboard.press('Home');
  await page.waitForURL(/home/);
  const homeWorkbench = page.locator('[data-testid="simple-workbench"]:visible:not([data-tab-route])').last();
  await homeWorkbench.waitFor();
  const lastShortcut = homeWorkbench.getByTestId('workbench-sync-status');
  await lastShortcut.scrollIntoViewIfNeeded();
  await lastShortcut.evaluate(item => {
    for (let parent = item.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight) parent.scrollTop = parent.scrollHeight;
    }
  });
  await page.waitForTimeout(100);
  const item = await lastShortcut.boundingBox();
  const bar = await page.locator('taro-tabbar').boundingBox();
  assert.ok(item.y >= 0 && item.y + item.height < bar.y, 'last function row is reachable above dock: ' + JSON.stringify({ item, bar }));
  await page.screenshot({ path: 'release/navigation-' + name + '.png', fullPage: false });
  await page.setViewportSize({ width: 844, height: 390 });
  const rotated = await page.locator('taro-tabbar').boundingBox();
  assert.ok(rotated.y + rotated.height <= 391 && rotated.y >= 300);
  assert.deepEqual(errors, [], name + ' page errors');
  await page.close();
  console.log(name + ': startup, 5-tab navigation, native handshake, gestures, edges, cancellation, calculator and layout passed');
}

(async () => {
  fs.mkdirSync('release', { recursive: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const requestedEngines = (process.env.NAV_BROWSERS || process.env.NAV_ENGINES)
    ? (process.env.NAV_BROWSERS || process.env.NAV_ENGINES).split(',').map(name => name.trim()) : null;
  for (const [name, engine, executablePath] of [
    ['chromium', chromium, process.env.NAV_CHROMIUM],
    ['webkit', webkit, process.env.NAV_WEBKIT]
  ].filter(([name]) => !requestedEngines || requestedEngines.includes(name))) {
    const browser = await engine.launch({ executablePath });
    try { await verify(browser, name); } finally { await browser.close(); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => server.close());
