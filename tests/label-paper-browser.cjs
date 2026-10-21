// Verify the 70 x 100 mm default reaches the native media profile. The iOS bridge is mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

const webRoot = path.resolve(process.env.LABEL_PRINT_WEB_ROOT || 'dist');
const output = path.resolve(process.env.LABEL_PAPER_CHECK_DIR || 'release/label-paper-check');
const apiOrigin = 'https://youxishen.online';
const printerName = 'K3-I911020404';
const guest = { token: 'label-paper-local-fixture', user: { id: 'label-reader', username: 'reader', role: 'viewer' } };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,X-Warehouse-Device' };

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const filename = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(webRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return response.writeHead(404).end();
  response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(response);
});

(async () => {
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `Build H5 into a fresh isolated directory before running: ${webRoot}`);
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const requests = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(initial => {
      localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
      localStorage.setItem('warehouse_session_v1', JSON.stringify({ data: initial.guest }));
      const state = { connected: false, calls: [], profiles: [] };
      window.CapacitorCustomPlatform = { name: 'ios' };
      window.Capacitor = {
        PluginHeaders: [{ name: 'OfficialLabelPrinter', methods: ['getState', 'scanPrinters', 'connectPrinter', 'getActiveJob', 'getRecentJobs', 'saveMediaProfile', 'printCalibration', 'removeListener', 'addListener'].map(name => ({ name, rtype: name === 'addListener' ? 'callback' : 'promise' })) }],
        nativePromise(plugin, method, input) {
          state.calls.push({ plugin, method, input });
          if (plugin !== 'OfficialLabelPrinter') return Promise.reject(new Error('Unexpected native plugin: ' + plugin));
          if (method === 'getState') return Promise.resolve({ supported: true, connected: state.connected, printerName: state.connected ? initial.printerName : undefined, mediaProfiles: state.profiles, productionEnabled: false, maxCopies: 1, reason: '测试夹具：正式打印保持关闭' });
          if (method === 'scanPrinters') return Promise.resolve({ printers: [{ printerName: initial.printerName, connected: false }] });
          if (method === 'connectPrinter') { state.connected = true; return Promise.resolve(); }
          if (method === 'getActiveJob') return Promise.resolve({ job: null });
          if (method === 'getRecentJobs') return Promise.resolve({ jobs: [] });
          if (method === 'saveMediaProfile') { state.profiles = [input.profile]; return Promise.resolve(); }
          if (method === 'printCalibration') return Promise.resolve();
          if (method === 'removeListener') return Promise.resolve();
          return Promise.reject(new Error('Unexpected native method: ' + method));
        },
        nativeCallback() { return Promise.resolve('label-paper-fixture-listener'); }
      };
      window.__labelPaperFixture = state;
    }, { guest, printerName });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.origin !== apiOrigin || !url.pathname.startsWith('/api/')) return route.abort();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      requests.push({ path: url.pathname, method: request.method() });
      let data;
      if (url.pathname === '/api/auth/guest') data = guest;
      else if (url.pathname === '/api/sync') data = { revision: 1 };
      else if (url.pathname === '/api/boards') data = [];
      else if (url.pathname === '/api/products') data = { items: [], total: 0, page: 1, page_size: 12 };
      else return route.fulfill({ status: 500, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试未允许的 API' }) });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/pages/label-print/index');
    const field = label => page.getByLabel(label).locator('input');
    const width = field('实测宽度（mm）');
    const height = field('实测高度（mm）');
    const density = field('浓度（1–5）');
    const settings = page.locator('taro-button-core').filter({ hasText: /^打印机设置$/ });
    await expect(settings).toBeVisible();
    await settings.click();
    await expect(width).toHaveValue('70');
    await expect(height).toHaveValue('100');
    await expect(density).toHaveValue('3');
    await expect(page.getByText('第 1 步：点“搜索附近打印机”，选择精臣 K3 并核对铭牌型号。', { exact: true })).toBeVisible();

    const calibrate = page.locator('taro-button-core').filter({ hasText: /^打印校准样张$/ });
    await expect(calibrate).not.toHaveAttribute('disabled', '');
    await calibrate.click();
    await expect(page.locator('#calibration-action-error')).toContainText('请先连接精臣 K3，再打印校准样张。');

    const scan = page.locator('taro-button-core').filter({ hasText: /^搜索附近打印机$/ });
    await scan.click();
    const device = page.locator('.label-printer-device').filter({ hasText: printerName });
    await device.locator('taro-button-core').click();
    const modal = page.locator('.taro-modal__content:visible');
    await expect(modal).toContainText('核对打印机铭牌');
    await modal.locator('.taro-model__confirm').click();
    await expect(page.locator('.label-printer-status')).toContainText(`已连接 · ${printerName}`);
    await expect(modal).toHaveCount(0);
    await expect(width).toHaveValue('70');
    await expect(height).toHaveValue('100');
    await expect(density).toHaveValue('3');
    await expect(page.getByText('第 2 步：纸张已填 70 × 100 mm。补全四边边距后，点“保存纸张配置”。', { exact: true })).toBeVisible();
    await page.locator('[class*=setupGuide]').filter({ hasText: '当前下一步' }).first().screenshot({ path: path.join(output, 'label-calibration-next-step.png'), animations: 'disabled' });
    await page.screenshot({ path: path.join(output, 'label-calibration-guide.png'), fullPage: true, animations: 'disabled' });

    for (const [label, value] of [['上边距（mm）', '2'], ['右边距（mm）', '2'], ['下边距（mm）', '2'], ['左边距（mm）', '2']]) {
      await field(label).fill(value);
    }
    const save = page.locator('taro-button-core').filter({ hasText: /^保存纸张配置$/ });
    await save.click();
    await expect(modal).toContainText('70 × 100 mm');
    await modal.locator('.taro-model__confirm').click();
    await expect.poll(() => page.evaluate(() => window.__labelPaperFixture.calls.filter(call => call.method === 'saveMediaProfile').length)).toBe(1);
    const calls = await page.evaluate(() => window.__labelPaperFixture.calls.filter(call => call.method === 'saveMediaProfile'));
    const profile = calls[0].input.profile;
    assert.equal(profile.widthMm, 70);
    assert.equal(profile.heightMm, 100);
    assert.equal(profile.paperStyle, 'gap');
    assert.equal(profile.density, 3);
    assert.deepEqual(profile.marginMm, { top: 2, right: 2, bottom: 2, left: 2 });
    assert.equal(profile.printerName, printerName);
    await expect(page.getByText('第 3 步：点“打印校准样张”会出一张纸，检查实物后再点“已核对校准实物”。', { exact: true })).toBeVisible();

    await calibrate.click();
    await expect(modal).toContainText('打印一张校准样张');
    await modal.locator('.taro-model__confirm').click();
    await expect.poll(() => page.evaluate(() => window.__labelPaperFixture.calls.filter(call => call.method === 'printCalibration').length)).toBe(1);
    const calibrationCall = await page.evaluate(() => window.__labelPaperFixture.calls.find(call => call.method === 'printCalibration'));
    assert.equal(calibrationCall.input.profileId, profile.profileId);
    assert.equal(calibrationCall.input.acknowledged, true);
    assert.match(calibrationCall.input.jobId, /^label-\d+-[a-z0-9]+$/);
    await page.screenshot({ path: path.join(output, 'label-paper-70x100.png'), fullPage: true, animations: 'disabled' });
    assert.deepEqual(errors, [], 'no runtime errors');
    assert.deepEqual(requests.filter(item => item.method !== 'GET' && item.path !== '/api/auth/guest'), [], 'paper setup never writes business records');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), browser: 'Chromium', build: webRoot, native: 'mocked Capacitor iOS bridge; not hardware acceptance', api: 'local fixture only; no business writes', profile, errors }, null, 2));
    console.log('Label 70 x 100 mm default browser check passed (mocked iOS bridge; no hardware print).');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
