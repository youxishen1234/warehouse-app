// Run against a fresh, isolated H5 build. All API responses are local fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

const webRoot = path.resolve(process.env.NAV_WEB_DIR || 'release/label-print-20261016-root/web');
const output = path.resolve(process.env.LABEL_RESOLVER_CHECK_DIR || 'release/label-print-20261016-root/resolver-browser');
const apiOrigin = 'https://youxishen.online';
const batchId = 'BOARD-20261016-A1B2C3D4E5F6';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,X-Warehouse-Device' };
const guest = { token: 'label-resolver-fixture', user: { id: 'label-reader', username: 'anonymous-reader', role: 'viewer' } };
const product = () => ({ id: 7, name: '标签成品样例', specification: '', length: 420.5, width: 260, unit: '箱', stock: 0, category: '纸箱', price: 91234.56, safety_stock: 4, created_at: 1, updated_at: 2, phone: 'SECRET-PRODUCT-PHONE', remark: 'SECRET-PRODUCT-REMARK' });
const board = () => ({ id: batchId, supplier: '标签板厂样例', boardLength: 120.5, boardWidth: 80, fluteType: 'AB', layers: 5, faceGsm: 180, linerGsm: 150, flutingGsm: 120, cartonLength: 42, cartonWidth: 26, cartonHeight: 18, date: '2026-10-16', location: 'A-1', receivedQty: 30, remainingQty: 0, unitPrice: 91234.56, amount: 93456.78, recipient: 'SECRET-BATCH-RECIPIENT', remark: 'SECRET-BATCH-REMARK', movements: [{ id: 'internal-movement-id', batchId, type: 'count', quantity: -3, balance: 0, createdAt: 1792137600000, date: '2026-10-16', recipient: 'SECRET-MOVEMENT-RECIPIENT', remark: 'SECRET-MOVEMENT-REMARK', phone: 'SECRET-MOVEMENT-PHONE' }] });
const reply = (route, data, status = 200, message = '') => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify({ success: status >= 200 && status < 300, data, message }) });
const target = (kind, id) => `/#/pages/label-resolver/index?v=1&kind=${kind}&id=${id}`;

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const filename = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(webRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return response.writeHead(404).end();
  response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(response);
});

async function fixture(browser, origin, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const requests = [], errors = [], unexpected = [];
  const state = { product: product(), board: board(), productMode: 'ok', boardMode: 'ok', guestFailures: options.guestFailures || 0 };
  await context.addInitScript(initial => {
    localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
    if (initial) localStorage.setItem('warehouse_session_v1', JSON.stringify({ data: initial }));
  }, options.initialGuest === false ? null : guest);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== apiOrigin || !url.pathname.startsWith('/api/')) { unexpected.push(request.url()); return route.abort(); }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    requests.push({ path: url.pathname, method: request.method(), at: Date.now() });
    if (url.pathname === '/api/auth/guest') {
      if (state.guestFailures-- > 0) return reply(route, null, 503, '测试连接暂时不可用');
      return reply(route, guest);
    }
    if (url.pathname === '/api/sync') return reply(route, { revision: 1 });
    if (url.pathname === '/api/health') return reply(route, { status: 'ok', authentication: false });
    if (url.pathname === '/api/products/7' || url.pathname === `/api/boards/${batchId}`) {
      const kind = url.pathname.includes('/products/') ? 'product' : 'board';
      if (state[`${kind}Mode`] === '404') return reply(route, null, 404, '记录不存在');
      if (state[`${kind}Mode`] === 'network') return route.abort('failed');
      return reply(route, state[kind]);
    }
    unexpected.push(request.url());
    return reply(route, null, 500, '测试未允许的 API');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  const done = async () => {
    assert.deepEqual(errors, [], 'no runtime errors');
    assert.deepEqual(unexpected, [], 'no unexpected API or external traffic');
    assert.deepEqual(requests.filter(item => item.method !== 'GET' && item.path !== '/api/auth/guest'), [], 'resolver never mutates business records');
  };
  return { context, page, state, requests, done };
}
const row = (page, title) => page.locator('.label-resolver-row').filter({ has: page.locator('.label-resolver-key', { hasText: title }) });

async function finishedProduct(browser, origin) {
  const f = await fixture(browser, origin);
  try {
    const url = origin + target('finished-product', 7);
    await f.page.goto(url);
    await expect(row(f.page, '商品名称')).toContainText('标签成品样例');
    await expect(row(f.page, '商品规格')).toContainText('420.5 × 260 mm');
    await expect(row(f.page, '当前库存')).toContainText('0 箱');
    assert.doesNotMatch(await f.page.locator('.label-resolver-page').innerText(), /SECRET|91234|价格|成本|领用|盘点/);
    await f.page.screenshot({ path: path.join(output, 'finished-product.png'), fullPage: true });
    const reads = f.requests.filter(item => item.path === '/api/products/7').length;
    f.state.product.stock = 6; f.state.product.unit = '个';
    await f.page.locator('.label-resolver-refresh').click();
    await expect(row(f.page, '当前库存')).toContainText('6 个');
    assert.ok(f.requests.filter(item => item.path === '/api/products/7').length > reads);
    f.state.product.stock = 9;
    await f.page.reload();
    await expect(row(f.page, '当前库存')).toContainText('9 个');
    assert.equal(f.page.url(), url, 'refresh preserves target route');
    await f.done();
    console.log('PASS finished product live whitelist, zero/unit handling and browser refresh');
  } finally { await f.context.close(); }
}

async function paperboard(browser, origin) {
  const f = await fixture(browser, origin);
  try {
    await f.page.goto(origin + target('paperboard-batch', batchId));
    await expect(row(f.page, '批次 ID')).toContainText(batchId);
    await expect(row(f.page, '纸板规格')).toContainText('120.5 × 80 cm');
    await expect(row(f.page, '当前余量')).toContainText('0 张');
    await expect(row(f.page, '实收数量')).toContainText('30 张');
    await expect(f.page.locator('.label-resolver-movement')).toContainText('盘点调整 · -3 张');
    await expect(f.page.locator('.label-resolver-movement')).toContainText('结余 0 张');
    assert.doesNotMatch(await f.page.locator('.label-resolver-page').innerText(), /SECRET|91234|93456|单价|货款|备注|领料人|联系方式/);
    assert.equal(await f.page.locator('.label-resolver-page button, .label-resolver-page taro-button-core').count(), 1);
    await f.page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await f.page.locator('.label-resolver-page').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'long batch ID does not overflow narrow view');
    await f.page.screenshot({ path: path.join(output, 'paperboard-320.png'), fullPage: true });
    await f.done();
    console.log('PASS paperboard read-only quantities and restricted movements at narrow width');
  } finally { await f.context.close(); }
}

async function failures(browser, origin) {
  const f = await fixture(browser, origin);
  try {
    f.state.productMode = '404';
    await f.page.goto(origin + target('finished-product', 7));
    await expect(f.page.locator('.label-resolver-error')).toContainText('已删除或不存在');
    assert.equal(await f.page.locator('.label-resolver-row').count(), 0);
    f.state.productMode = 'ok';
    await f.page.locator('.label-resolver-error').getByText('重新读取', { exact: true }).click();
    await expect(row(f.page, '商品名称')).toContainText('标签成品样例');
    f.state.productMode = 'network';
    await f.page.locator('.label-resolver-refresh').click();
    await expect(f.page.locator('.label-resolver-error')).toContainText('连接失败');
    assert.equal(await f.page.locator('.label-resolver-row').count(), 0, 'network failure never leaves old data presented as current');
    f.state.productMode = 'ok'; f.state.product.stock = 22;
    await f.page.locator('.label-resolver-error').getByText('重新读取', { exact: true }).click();
    await expect(row(f.page, '当前库存')).toContainText('22 箱');
    f.state.boardMode = '404';
    await f.page.goto(origin + target('paperboard-batch', batchId));
    await expect(f.page.locator('.label-resolver-error')).toContainText('已删除或不存在');
    await f.done();
    console.log('PASS deleted records and failed online refresh require explicit retry without stale detail');
  } finally { await f.context.close(); }
}

async function invalidLinks(browser, origin) {
  const f = await fixture(browser, origin);
  try {
    const query = target('finished-product', 7);
    const invalid = [query + '&id=8', query + '&secret=1', query.replace('v=1', 'v=2'), query.replace('finished-product', 'unknown-kind'), query.replace('id=7', 'id=..%2F7')];
    for (const value of invalid) {
      await f.page.goto(origin + value);
      await expect(f.page.locator('.label-resolver-error')).toBeVisible();
      assert.equal(await f.page.locator('.label-resolver-row').count(), 0);
    }
    assert.equal(f.requests.filter(item => item.path.startsWith('/api/products/') || item.path.startsWith('/api/boards/')).length, 0, 'invalid links never issue a detail request');
    await f.done();
    console.log('PASS duplicate, unknown, unsupported-version/type and unsafe-ID routes reject before API');
  } finally { await f.context.close(); }
}

async function anonymousRecovery(browser, origin) {
  const f = await fixture(browser, origin, { initialGuest: false, guestFailures: 1 });
  try {
    const url = origin + target('paperboard-batch', batchId);
    await f.page.goto(url);
    await expect(f.page.locator('.team-boot')).toBeVisible();
    assert.equal(f.requests.filter(item => item.path === '/api/auth/guest').length, 1);
    await f.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(f.page.locator('.team-boot')).toHaveCount(0, { timeout: 10000 });
    await expect(row(f.page, '批次 ID')).toContainText(batchId);
    assert.equal(f.page.url(), url, 'guest recovery retains version/kind/business ID');
    assert.ok(f.requests.filter(item => item.path === '/api/auth/guest').length >= 2);
    assert.ok(f.requests.some(item => item.path === `/api/boards/${batchId}`));
    await f.page.reload();
    await expect(row(f.page, '批次 ID')).toContainText(batchId);
    assert.equal(f.page.url(), url);
    await f.done();
    console.log('PASS anonymous first-open recovery and reload preserve the exact label target');
  } finally { await f.context.close(); }
}

(async () => {
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `Build H5 before running: ${webRoot}`);
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch();
    const scenarios = [];
    for (const scenario of [finishedProduct, paperboard, failures, invalidLinks, anonymousRecovery]) {
      await scenario(browser, origin);
      scenarios.push({ name: scenario.name, passed: true });
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), browser: 'Chromium', build: webRoot, api: 'local fixture only', scenarios, screenshots: ['finished-product.png', 'paperboard-320.png'] }, null, 2));
    console.log('Label resolver browser checks passed (Chromium, local fixture API only).');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
