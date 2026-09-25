const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('playwright');

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
    const target = Array.from(document.querySelectorAll('.taro_page')).reverse().find(p => getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().height > 0);
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
  await page.route(/\/api\//, route => {
    const url = new URL(route.request().url());
    let data = [];
    if (url.pathname.endsWith('/auth/guest')) data = { token: 'test-token', user: { id: '1', username: 'preview', role: 'viewer' } };
    if (url.pathname.endsWith('/stats')) data = { todayIn: 0, todayOut: 0, totalProducts: 0, totalStock: 0, lowStock: 0, totalValue: 0 };
    if (url.pathname.endsWith('/sync')) data = { revision: 1 };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
  });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForSelector('.weui-tabbar__item');
  await page.waitForFunction(() => document.querySelector('[class*="funcGrid___"]'));
  assert.equal(await page.locator('.sg-home-search').count(), 0, 'search removed');
  assert.equal(await page.locator('.sg-quick-add').count(), 0);
  assert.equal(await page.locator('.sg-corrugated-item').count(), 1, 'calculator preserved');
  const before = await page.locator('taro-tabbar').boundingBox();
  assert.ok(before.y > 700 && before.y + before.height <= 845, JSON.stringify(before));
  assert.notEqual(await swipe(page, -110), 'none', 'gesture follows finger');
  await page.waitForURL(/inbound/);
  await page.waitForTimeout(500);
  await swipe(page, -110);
  await page.waitForURL(/outbound/);
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
  await page.waitForURL(/outbound/);
  for (const route of ['/pages/inbound/index', '/pages/outbound/index', '/pages/mine/index', '/pages/home/index']) {
    await page.evaluate(route => window.dispatchEvent(new CustomEvent('sg-native-tab', { detail: route })), route);
    await page.waitForURL(new RegExp(route));
    await page.waitForTimeout(500);
    await page.waitForFunction(route => window.__nativeMessages.at(-1)?.route === route, route);
  }
  const pageText = await page.locator('body').innerText();
  assert.ok(pageText.includes('客户订单') && pageText.includes('新增商品') && pageText.includes('瓦楞计算'));
  await page.locator('.sg-corrugated-item').click();
  await page.waitForSelector('.sg-calc-dialog');
  await page.waitForFunction(() => window.__nativeMessages.at(-1)?.modal === true);
  await page.locator('.sg-calc-close').click();
  await page.waitForFunction(() => window.__nativeMessages.at(-1)?.modal === false);
  await page.evaluate(() => {
    delete window.__sgNativeDock;
    window.dispatchEvent(new Event('sg-native-ready'));
  });
  await page.waitForFunction(() => !document.documentElement.classList.contains('sg-native-ios'));
  await page.locator('.sg-corrugated-item').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const item = document.querySelector('.sg-corrugated-item');
    for (let parent = item.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight) parent.scrollTop = parent.scrollHeight;
    }
  });
  await page.waitForTimeout(100);
  const item = await page.locator('.sg-corrugated-item').boundingBox();
  const bar = await page.locator('taro-tabbar').boundingBox();
  assert.ok(item.y >= 0 && item.y + item.height < bar.y, 'last function row is reachable above dock: ' + JSON.stringify({ item, bar }));
  await page.screenshot({ path: 'release/navigation-' + name + '.png', fullPage: false });
  await page.setViewportSize({ width: 844, height: 390 });
  const rotated = await page.locator('taro-tabbar').boundingBox();
  assert.ok(rotated.y + rotated.height <= 391 && rotated.y >= 320);
  assert.deepEqual(errors, [], name + ' page errors');
  await page.close();
  console.log(name + ': startup, 4-tab navigation, native handshake, gestures, edges, cancellation, calculator and layout passed');
}

(async () => {
  fs.mkdirSync('release', { recursive: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  for (const [name, engine, executablePath] of [
    ['chromium', chromium, process.env.NAV_CHROMIUM],
    ['webkit', webkit, process.env.NAV_WEBKIT]
  ]) {
    const browser = await engine.launch({ executablePath });
    try { await verify(browser, name); } finally { await browser.close(); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => server.close());
