// Run against a fresh, isolated H5 build. Native calls and API responses are local fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

const webRoot = path.resolve(process.env.NAV_WEB_DIR || 'release/label-connection-check/web');
const output = path.resolve(process.env.LABEL_CONNECTION_CHECK_DIR || 'release/label-connection-check/browser');
const apiOrigin = 'https://youxishen.online';
const printerName = 'K3-I911020404';
const guest = { token: 'label-connection-local-fixture', user: { id: 'label-reader', username: 'anonymous-reader', role: 'viewer' } };
const automaticPrinter = {
  client: 'c'.repeat(64),
  device: { id: 'label-connection-local-default', name: '本机隔离打印电脑', printer: 'EPSON LQ-630K', online: true, ready: true }
};
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,X-Warehouse-Device,X-Print-Client' };
const results = [];
const evidence = [];
const layoutEvidence = [];
// Taro treats any disabled attribute, including disabled="false", as disabled.
// Assert absence rather than accepting a nonempty attribute as enabled.
const expectEnabled = async locator => expect.poll(() => locator.getAttribute('disabled')).toBeNull();

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const filename = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(webRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return response.writeHead(404).end();
  response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(response);
});

async function fixture(browser, origin, scenario, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const requests = [], connections = [], errors = [], unexpected = [], logs = [];
  // @capacitor/core discovers native methods through PluginHeaders, then delegates
  // its real registerPlugin proxy to nativePromise/nativeCallback. Do not replace
  // the app's service, supported checks, modal implementation, or component logic.
  await context.addInitScript(initial => {
    localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
    localStorage.setItem('warehouse_session_v1', JSON.stringify({ data: initial.guest }));
    const state = { connected: false, pending: null, calls: [], failHistory: initial.failHistory, failActive: initial.failActive, hangJobs: initial.hangJobs, holdStateReads: false, heldStateReads: [] };
    const current = () => ({ supported: true, connected: state.connected, printerName: state.connected ? initial.printerName : undefined, mediaProfiles: [], productionEnabled: false, maxCopies: 1, hardwareBusy: Boolean(state.pending), reason: '测试夹具：正式打印保持关闭' });
    const methods = ['getState', 'scanPrinters', 'connectPrinter', 'getActiveJob', 'getRecentJobs', 'disconnectPrinter', 'removeListener'];
    window.CapacitorCustomPlatform = { name: 'ios' };
    window.Capacitor = {
      PluginHeaders: [{ name: 'OfficialLabelPrinter', methods: [...methods.map(name => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }] }],
      nativePromise(plugin, method, input) {
        state.calls.push({ plugin, method, input, at: Date.now(), connected: state.connected });
        if (plugin !== 'OfficialLabelPrinter') return Promise.reject(new Error(`Unexpected native plugin: ${plugin}`));
        if (method === 'getState') {
          const snapshot = current();
          if (state.holdStateReads) return new Promise((resolve, reject) => { state.heldStateReads.push({ resolve, reject, snapshot }); });
          return Promise.resolve(snapshot);
        }
        if (state.hangJobs && ['getActiveJob', 'getRecentJobs'].includes(method)) return new Promise(() => {});
        if (method === 'getActiveJob') return state.failActive ? Promise.reject(new Error('本机活动任务读取失败（测试）')) : Promise.resolve({ job: null });
        if (method === 'getRecentJobs') return state.failHistory ? Promise.reject(new Error('本机历史记录读取失败（测试）')) : Promise.resolve({ jobs: [] });
        if (method === 'scanPrinters') return Promise.resolve({ printers: [{ printerName: initial.printerName, connected: false }] });
        if (method === 'connectPrinter') {
          if (state.pending) return Promise.reject(new Error('Duplicate native connection attempt'));
          return new Promise((resolve, reject) => { state.pending = { resolve, reject }; });
        }
        if (method === 'disconnectPrinter') { state.connected = false; return Promise.resolve(); }
        if (method === 'removeListener') return Promise.resolve();
        return Promise.reject(new Error(`Unexpected native method: ${method}`));
      },
      nativeCallback(plugin, method, input) {
        state.calls.push({ plugin, method, input, at: Date.now(), connected: state.connected });
        return Promise.resolve('label-connection-fixture-listener');
      }
    };
    window.__labelConnectionFixture = {
      state,
      finishState(index = 0) {
        const pending = state.heldStateReads[index];
        if (!pending) throw new Error('No held state read at index ' + index);
        state.heldStateReads[index] = null;
        pending.resolve(pending.snapshot);
      },
      finishConnect(mode = 'success') {
        if (!state.pending) throw new Error('No native connection is pending');
        const pending = state.pending; state.pending = null;
        if (mode === 'reject') pending.reject(new Error('K3 连接失败：测试设备未响应'));
        else { state.connected = mode !== 'unconfirmed'; pending.resolve(); }
      }
    };
  }, { guest, printerName, failHistory: Boolean(options.failHistory), failActive: Boolean(options.failActive), hangJobs: Boolean(options.hangJobs) });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== apiOrigin || !url.pathname.startsWith('/api/')) { unexpected.push(request.url()); return route.abort(); }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === '/api/remote-print/connect' && request.method() === 'POST') {
      const body = request.postDataJSON();
      assert.deepEqual(body, {}, 'automatic discovery accepts no connection code or business payload');
      connections.push({ method: request.method(), path: url.pathname, body });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: true, data: automaticPrinter }) });
    }
    requests.push({ path: url.pathname, method: request.method() });
    if (url.pathname === '/api/remote-print/labels/device' && request.method() === 'GET') {
      assert.equal(request.headers()['x-print-client'], automaticPrinter.client);
      return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: false, message: '这台电脑尚未登记标签打印机' }) });
    }
    let data;
    if (url.pathname === '/api/auth/guest') data = guest;
    else if (url.pathname === '/api/sync') data = { revision: 1 };
    else if (url.pathname === '/api/health') data = { status: 'ok', authentication: false };
    else if (url.pathname === '/api/boards') data = [];
    else if (url.pathname === '/api/products') data = { items: [], total: 0, page: 1, page_size: 12 };
    else { unexpected.push(request.url()); return route.fulfill({ status: 500, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试未允许的 API' }) }); }
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/label|printer|连接/i.test(message.text())) logs.push({ type: message.type(), message: message.text() }); });
  const calls = method => page.evaluate(name => window.__labelConnectionFixture.state.calls.filter(item => item.method === name), method);
  const device = page.locator('.label-printer-device').filter({ hasText: printerName });
  const choose = device.locator('taro-button-core');
  const scan = page.locator('taro-button-core').filter({ hasText: /^搜索附近打印机$/ });
  const refresh = page.locator('taro-button-core').filter({ hasText: /^刷新状态$/ });
  const status = page.locator('.label-printer-status');
  const feedback = page.locator('.label-printer-feedback');
  const modal = page.locator('.taro-modal__content:visible');
  const open = async () => {
    await page.goto(origin + '/#/pages/management/index?section=labels');
    await page.locator('taro-button-core').filter({ hasText: /^切换手机蓝牙打印$/ }).click();
    const settings = page.locator('taro-button-core').filter({ hasText: /^打印机设置$/ });
    await expectEnabled(settings);
    await settings.click();
    await expect(scan).toBeVisible();
    await expectEnabled(scan);
    await expect(status).toContainText('尚未连接');
    await scan.click();
    await expect(device).toBeVisible();
    await expectEnabled(choose);
  };
  const confirm = async () => {
    await choose.click();
    await expect(modal).toContainText('核对打印机铭牌');
    assert.equal((await calls('connectPrinter')).length, 0, 'model confirmation precedes native connect');
    await modal.locator('.taro-model__confirm').click();
    await expect.poll(async () => (await calls('connectPrinter')).length).toBe(1);
    await expect(modal).toHaveCount(0);
  };
  const finish = () => page.evaluate(() => window.__labelConnectionFixture.finishConnect());
  const done = async () => {
    assert.deepEqual(errors, [], 'no uncaught runtime errors');
    assert.deepEqual(unexpected, [], 'no unexpected or real external traffic');
    assert.deepEqual(requests.filter(item => item.method !== 'GET' && item.path !== '/api/auth/guest'), [], 'connection never mutates business records');
    const native = await page.evaluate(() => window.__labelConnectionFixture.state.calls);
    assert.ok(native.every(call => call.plugin === 'OfficialLabelPrinter'), 'only the official new printer bridge is used');
    assert.ok(native.every(call => !/printLabel|printCalibration/.test(call.method)), 'connection never prints');
  };
  const close = async () => {
    try {
      await page.screenshot({ path: path.join(output, scenario + '.png'), fullPage: true, animations: 'disabled' });
      evidence.push({ scenario, requests, connections, errors, unexpected, logs, nativeCalls: await page.evaluate(() => window.__labelConnectionFixture?.state.calls || []), status: await status.allTextContents(), feedback: await feedback.allTextContents() });
    } finally { await context.close(); }
  };
  return { page, device, choose, scan, refresh, status, feedback, modal, calls, open, confirm, finish, done, close };
}

async function connectionSuccess(browser, origin) {
  const f = await fixture(browser, origin, 'connection-success');
  try {
    await f.open(); await f.confirm();
    assert.deepEqual((await f.calls('connectPrinter'))[0].input, { printerName, modelConfirmed: true });
    await f.finish();
    await expect(f.status).toContainText(`已连接 · ${printerName}`);
    await expectEnabled(f.scan);
    assert.equal((await f.calls('connectPrinter')).length, 1);
    const save = f.page.locator('taro-button-core').filter({ hasText: /^保存纸张配置$/ });
    const board = f.page.locator('taro-button-core').filter({ hasText: /^纸板批次标签$/ });
    const product = f.page.locator('taro-button-core').filter({ hasText: /^成品标签$/ });
    await expectEnabled(save); await expectEnabled(board); await expectEnabled(product);
    await expect(save).toHaveCSS('opacity', '1');
    await expect(f.scan).toHaveCSS('opacity', '1');
    await board.click();
    await expect(f.page.getByText('1 · 选择纸板批次', { exact: true })).toBeVisible();
    await product.click();
    await expect(f.page.getByText('1 · 选择商品', { exact: true })).toBeVisible();
    assert.equal((await f.calls('connectPrinter')).length, 1, 'switching label types after connection never reconnects');
    assert.ok((await f.calls('getState')).some(call => call.connected === true), 'success is verified through real getState bridge, not fabricated by UI');
    await f.done();
  } finally { await f.close(); }
}

async function confirmationCancelled(browser, origin) {
  const f = await fixture(browser, origin, 'confirmation-cancelled');
  try {
    await f.open(); await f.choose.click();
    await expect(f.modal).toContainText('核对打印机铭牌');
    await f.modal.locator('.taro-model__cancel').click();
    await expect(f.modal).toHaveCount(0);
    await expectEnabled(f.scan);
    await expect(f.status).toContainText('尚未连接');
    assert.equal((await f.calls('connectPrinter')).length, 0, 'cancelling confirmation never calls native connect');
    await f.done();
  } finally { await f.close(); }
}

async function nativeRejectionVisible(browser, origin) {
  const f = await fixture(browser, origin, 'native-rejection-visible');
  try {
    await f.open(); await f.confirm();
    await f.page.evaluate(() => window.__labelConnectionFixture.finishConnect('reject'));
    await expect(f.feedback).toContainText('K3 连接失败：测试设备未响应');
    await expect(f.feedback).toBeVisible();
    await expectEnabled(f.scan);
    const positions = await Promise.all([f.feedback.boundingBox(), f.scan.boundingBox()]);
    assert.ok(positions.every(Boolean) && Math.abs(positions[0].y - positions[1].y) < 400, 'connection error is next to printer controls, not hidden at the page bottom');
    await expect(f.status).toContainText('尚未连接');
    assert.equal((await f.calls('connectPrinter')).length, 1, 'native failure does not automatically retry');
    await f.done();
  } finally { await f.close(); }
}

async function auxiliaryFailuresDoNotHideConnection(browser, origin) {
  for (const option of ['failHistory', 'failActive']) {
    const f = await fixture(browser, origin, 'auxiliary-' + option, { [option]: true });
    try {
      await f.open(); await f.confirm(); await f.finish();
      await expect(f.status).toContainText(`已连接 · ${printerName}`);
      await expectEnabled(f.scan);
      await f.refresh.click();
      await expect(f.status).toContainText(`已连接 · ${printerName}`);
      assert.ok((await f.calls(option === 'failHistory' ? 'getRecentJobs' : 'getActiveJob')).length > 0, 'the auxiliary rejection path actually executed');
      await f.done();
    } finally { await f.close(); }
  }
}

async function doubleTapDoesNotDuplicate(browser, origin) {
  const f = await fixture(browser, origin, 'double-tap-single-connect');
  try {
    await f.open();
    // Two synchronous events exercise the ref lock before a React rerender.
    await f.choose.evaluate(element => { element.click(); element.click(); });
    await expect(f.modal).toHaveCount(1);
    await f.modal.locator('.taro-model__confirm').evaluate(element => { element.click(); element.click(); });
    await expect.poll(async () => (await f.calls('connectPrinter')).length).toBe(1);
    await expect(f.modal).toHaveCount(0);
    await expect(f.choose).toHaveAttribute('disabled', '');
    await f.finish();
    await expect(f.status).toContainText(`已连接 · ${printerName}`);
    assert.equal((await f.calls('connectPrinter')).length, 1);
    await f.done();
  } finally { await f.close(); }
}

async function pendingJobReadsDoNotBlockConnection(browser, origin) {
  const f = await fixture(browser, origin, 'pending-job-reads', { hangJobs: true });
  try {
    await f.open(); await f.confirm(); await f.finish();
    await expect(f.status).toContainText(`已连接 · ${printerName}`);
    await expectEnabled(f.scan);
    assert.ok((await f.calls('getActiveJob')).length > 0 && (await f.calls('getRecentJobs')).length > 0, 'both job reads remain pending while connection completes');
    await f.done();
  } finally { await f.close(); }
}

async function resolvedNativeRequiresVerifiedState(browser, origin) {
  const f = await fixture(browser, origin, 'native-resolved-unconfirmed-state');
  try {
    await f.open(); await f.confirm();
    await f.page.evaluate(() => window.__labelConnectionFixture.finishConnect('unconfirmed'));
    await expect(f.feedback).toContainText('SDK 未确认目标 K3 已连接');
    await expect(f.status).toContainText('尚未连接');
    await expectEnabled(f.scan);
    assert.equal((await f.calls('connectPrinter')).length, 1, 'unconfirmed native result never retries automatically');
    await f.done();
  } finally { await f.close(); }
}

async function pendingConnectionHasFeedback(browser, origin) {
  const f = await fixture(browser, origin, 'pending-connection-visible');
  try {
    await f.open(); await f.confirm();
    await expect(f.scan).toHaveAttribute('disabled', '');
    await expect(f.choose).toHaveAttribute('disabled', '');
    await expectEnabled(f.refresh);
    await expect(f.status).toContainText(/正在连接|连接中/);
    await expect(f.feedback).toContainText(/正在连接|连接中/);
    await expect(f.feedback).toBeVisible();
    assert.doesNotMatch(await f.status.innerText(), /已连接/);
    await f.page.screenshot({ path: path.join(output, 'pending-before-native-resolution.png'), fullPage: true });
    await f.finish();
    await expect(f.status).toContainText(`已连接 · ${printerName}`);
    await expectEnabled(f.choose);
    assert.equal((await f.calls('connectPrinter')).length, 1);
    await f.done();
  } finally { await f.close(); }
}

async function watchdogDoesNotUnlockPendingNative(browser, origin) {
  const f = await fixture(browser, origin, 'watchdog-keeps-native-pending');
  try {
    await f.open();
    await f.page.clock.install();
    await f.confirm();
    await f.page.clock.fastForward(36000);
    await expect(f.feedback).toContainText('连接结果未确认');
    await expect(f.scan).toHaveAttribute('disabled', '');
    await expect(f.choose).toHaveAttribute('disabled', '');
    await expectEnabled(f.refresh);
    await f.refresh.click();
    await expect(f.scan).toHaveAttribute('disabled', '');
    await expect(f.choose).toHaveAttribute('disabled', '');
    assert.equal((await f.calls('connectPrinter')).length, 1, 'watchdog and read-only refresh never retry a pending native connection');
    await f.page.screenshot({ path: path.join(output, 'watchdog-before-native-resolution.png'), fullPage: true });
    await f.finish();
    await expect(f.status).toContainText(`已连接 · ${printerName}`);
    await expectEnabled(f.choose);
    await expect(f.feedback).not.toContainText('连接结果未确认');
    await f.done();
  } finally { await f.close(); }
}

async function manualRefreshPreservesConnectionFailure(browser, origin) {
  const f = await fixture(browser, origin, 'manual-refresh-preserves-connection-error');
  try {
    await f.open(); await f.confirm();
    await f.page.evaluate(() => window.__labelConnectionFixture.finishConnect('reject'));
    await expect(f.feedback).toContainText('K3 连接失败：测试设备未响应');
    await expectEnabled(f.scan);
    const before = (await f.calls('getState')).length;
    await f.refresh.click();
    await expect.poll(async () => (await f.calls('getState')).length).toBeGreaterThan(before);
    await expect(f.feedback).toContainText('K3 连接失败：测试设备未响应');
    await expect(f.status).toContainText('尚未连接');
    assert.equal((await f.calls('connectPrinter')).length, 1);
    await f.done();
  } finally { await f.close(); }
}

async function pendingStateVerificationKeepsConnectionLocked(browser, origin) {
  const f = await fixture(browser, origin, 'pending-state-verification-locked');
  try {
    await f.open(); await f.confirm();
    await f.page.evaluate(() => { window.__labelConnectionFixture.state.holdStateReads = true; });
    await f.finish();
    await expect.poll(() => f.page.evaluate(() => window.__labelConnectionFixture.state.heldStateReads.length)).toBe(1);
    await expect(f.status).toContainText('正在核对连接状态');
    await expect(f.scan).toHaveAttribute('disabled', '');
    await expect(f.choose).toHaveAttribute('disabled', '');
    await expectEnabled(f.refresh);
    await f.choose.evaluate(element => { element.click(); element.click(); });
    assert.equal((await f.calls('connectPrinter')).length, 1, 'native resolution does not unlock while state verification remains pending');
    await f.page.evaluate(() => {
      window.__labelConnectionFixture.state.holdStateReads = false;
      window.__labelConnectionFixture.finishState(0);
    });
    await expect(f.status).toContainText(`已连接 · ${printerName}`);
    await expectEnabled(f.scan);
    await expectEnabled(f.choose);
    await f.done();
  } finally { await f.close(); }
}

async function staleVerificationCannotReportSuccess(browser, origin) {
  const f = await fixture(browser, origin, 'stale-verification-no-false-success');
  try {
    await f.open(); await f.confirm();
    await f.page.evaluate(() => { window.__labelConnectionFixture.state.holdStateReads = true; });
    await f.finish();
    await expect.poll(() => f.page.evaluate(() => window.__labelConnectionFixture.state.heldStateReads.length)).toBe(1);
    // Verification captured connected=true, but a newer manual read sees disconnect.
    await f.page.evaluate(() => {
      window.__labelConnectionFixture.state.connected = false;
      window.__labelFeedbackHistory = [];
      window.__labelFeedbackObserver = new MutationObserver(() => {
        window.__labelFeedbackHistory.push(document.querySelector('.label-printer-feedback').textContent);
      });
      window.__labelFeedbackObserver.observe(document.querySelector('.label-printer-feedback'), { subtree: true, childList: true, characterData: true });
    });
    await f.refresh.click();
    await expect.poll(() => f.page.evaluate(() => window.__labelConnectionFixture.state.heldStateReads.length)).toBe(2);
    await f.page.evaluate(() => window.__labelConnectionFixture.finishState(1));
    await expect(f.choose).toHaveAttribute('disabled', '');
    await f.page.evaluate(() => {
      window.__labelConnectionFixture.state.holdStateReads = false;
      window.__labelConnectionFixture.finishState(0);
    });
    await expect(f.status).toContainText('尚未连接');
    await expectEnabled(f.scan);
    await expect(f.feedback).not.toContainText(`已连接 ${printerName}`);
    const feedbackHistory = await f.page.evaluate(() => { window.__labelFeedbackObserver.disconnect(); return window.__labelFeedbackHistory; });
    assert.ok(feedbackHistory.every(text => !text.includes('已连接 ' + printerName)), 'stale state verification never transiently publishes connection success');
    assert.equal((await f.calls('connectPrinter')).length, 1);
    await f.done();
  } finally { await f.close(); }
}

async function narrowLayoutDoesNotScrollHorizontally(browser, origin) {
  for (const width of [320, 390]) {
    const f = await fixture(browser, origin, `layout-${width}`);
    try {
      await f.page.setViewportSize({ width, height: 844 });
      await f.open();
      const checkLayout = async stage => {
        const layout = await f.page.evaluate(() => {
          const status = document.querySelector('.label-printer-status');
          const page = status.closest('.taro_page');
          const root = status.closest('[class*=index-module__page___]');
          const rect = element => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right }; };
          const style = getComputedStyle(status);
          return { viewport: innerWidth, page: { clientWidth: page.clientWidth, scrollWidth: page.scrollWidth, scrollLeft: page.scrollLeft }, root: { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth }, status: { ...rect(status), text: status.textContent, lineHeight: parseFloat(style.lineHeight) }, controls: Array.from(root.querySelectorAll('.label-printer-device, taro-button-core, input')).filter(element => element.getBoundingClientRect().width > 0).map(element => ({ text: element.textContent, ...rect(element) })) };
        });
        layoutEvidence.push({ width, stage, ...layout });
        assert.ok(layout.page.scrollWidth <= layout.page.clientWidth + 1, `${width}px ${stage}: Taro page has no horizontal overflow`);
        assert.ok(layout.root.scrollWidth <= layout.root.clientWidth + 1, `${width}px ${stage}: label root has no horizontal overflow`);
        assert.equal(layout.page.scrollLeft, 0, `${width}px ${stage}: device selection does not scroll the page sideways`);
        assert.ok(layout.status.width >= width * 0.4, `${width}px ${stage}: status retains readable width instead of collapsing beside a full-width button`);
        assert.ok(layout.status.height <= layout.status.lineHeight * 3 + 1, `${width}px ${stage}: status is not squeezed into one-character lines`);
        assert.ok(layout.controls.every(control => control.x >= -1 && control.right <= width + 1), `${width}px ${stage}: device controls and fields fit the viewport`);
      };
      await checkLayout('scanned');
      await f.confirm();
      await checkLayout('after-device-selection');
      await f.finish();
      await expect(f.status).toContainText(`已连接 · ${printerName}`);
      await checkLayout('connected');
      await f.page.screenshot({ path: path.join(output, `layout-${width}-connected.png`), fullPage: true, animations: 'disabled' });
      await f.done();
    } finally { await f.close(); }
  }
}

(async () => {
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `Build H5 into a fresh isolated directory before running: ${webRoot}`);
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch();
    for (const scenario of [connectionSuccess, confirmationCancelled, nativeRejectionVisible, auxiliaryFailuresDoNotHideConnection, doubleTapDoesNotDuplicate, pendingConnectionHasFeedback, watchdogDoesNotUnlockPendingNative, pendingJobReadsDoNotBlockConnection, resolvedNativeRequiresVerifiedState, narrowLayoutDoesNotScrollHorizontally, manualRefreshPreservesConnectionFailure, pendingStateVerificationKeepsConnectionLocked, staleVerificationCannotReportSuccess]) {
      try {
        await scenario(browser, origin);
        results.push({ name: scenario.name, passed: true });
        console.log('PASS ' + scenario.name);
      } catch (error) { results.push({ name: scenario.name, passed: false, error: error.stack || String(error) }); throw error; }
    }
    console.log('Label connection browser checks passed (Chromium, mocked iOS bridge and local fixture API only).');
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), browser: 'Chromium', build: webRoot, native: 'mocked Capacitor iOS bridge; not hardware acceptance', api: 'local fixture only; all external traffic intercepted', scenarios: results, evidence, layoutEvidence }, null, 2));
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
