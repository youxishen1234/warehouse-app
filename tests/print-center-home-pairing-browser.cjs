const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'print-center-home-pairing-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_REMOTE_PRINT_FILE = path.join(directory, 'remote-print.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('../backend/db');
  const store = require('../backend/remote-print').createStore(process.env.WAREHOUSE_REMOTE_PRINT_FILE);
  const pair = store.register('店里打印电脑', 'EPSON LQ-630K ESC/P2', { autoConnect: true });
  const automatic = store.autoConnect();
  const replacement = store.register('另一台打印电脑', 'EPSON LQ-630K ESC/P2');
  store.claim(pair.agent, true);
  store.claim(replacement.agent, true);
  const built = !!process.env.PRINT_HOME_WEB_DIR;
  if (built) process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.PRINT_HOME_WEB_DIR);
  const app = built ? require('../backend/server') : require('./helpers/print-center-source.cjs')(db);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const submitted = [];
  const routePage = async (context, state, discoveries) => {
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/remote-print/connect') {
        discoveries.push(request.postDataJSON());
        if (state.missing) return route.fulfill({
          status: 404, contentType: 'application/json',
          body: JSON.stringify({ success: false, message: '本仓库尚未设置默认打印电脑，请启动电脑接收器后重试' })
        });
      }
      if (url.pathname === '/api/remote-print/jobs' && request.method() === 'POST') {
        submitted.push(request.method());
        return route.abort();
      }
      if (url.pathname.startsWith('/api/')) {
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({ response });
      }
      return url.origin === origin || !/^https?:$/.test(url.protocol) ? route.continue() : route.abort();
    });
  };
  const newPage = async (storage = {}, state = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    await context.addInitScript(({ values, built }) => {
      Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, JSON.stringify(built ? { data: value } : value)));
      if (built) localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
    }, { values: storage, built });
    const discoveries = [];
    await routePage(context, state, discoveries);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    return { page, discoveries };
  };
  const storedPairMatches = (page, value) => page.evaluate(expected => {
    try {
      const stored = JSON.parse(localStorage.getItem('warehouse_remote_print_pair_v1'));
      return (stored?.data ?? stored) === expected;
    } catch { return false; }
  }, value);
  const connectionFor = page => page.getByRole('region', { name: '连接打印电脑' });
  try {
    const { page, discoveries } = await newPage();
    await page.goto(`${origin}/#/pages/print-center/index`);
    const connection = connectionFor(page);
    await expect(connection).toBeVisible();
    await expect(connection).toContainText('店里打印电脑');
    await expect(connection).toContainText('EPSON LQ-630K ESC/P2');
    await expect(connection).toContainText('电脑在线');
    await expect.poll(() => storedPairMatches(page, automatic.client)).toBe(true);
    assert.equal(discoveries.length, 1, 'the first visit discovers the explicitly enabled warehouse computer');
    assert.deepEqual(discoveries[0], {}, 'no connection code is supplied');
    await expect(connection).not.toContainText(/配对码|二维码|扫码/);
    await expect(page.locator('input[type=file]')).toHaveCount(0);
    await page.reload();
    await expect(connection).toContainText('店里打印电脑');
    await expect(connection).toContainText('电脑在线');
    assert.equal(discoveries.length, 1, 'reload keeps the validated computer without rediscovery');
    for (const width of [320, 390, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = await connection.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, overflow: element.scrollWidth > element.clientWidth + 1, width: innerWidth };
      });
      assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1 && !bounds.overflow, `connection remains in ${width}px viewport`);
    }

    const { page: invalid } = await newPage();
    await invalid.goto(`${origin}/#/pages/print-center/index?print_pair=invalid`);
    await expect(connectionFor(invalid)).toContainText('店里打印电脑');
    await expect.poll(() => invalid.evaluate(() => location.href.includes('print_pair='))).toBe(false);
    await expect.poll(() => storedPairMatches(invalid, automatic.client)).toBe(true);
    const { page: rejected } = await newPage({ warehouse_remote_print_pair_v1: 'f'.repeat(64) });
    await rejected.goto(`${origin}/#/pages/print-center/index`);
    await expect(connectionFor(rejected)).toContainText('店里打印电脑');
    await expect.poll(() => storedPairMatches(rejected, automatic.client)).toBe(true);

    const unavailable = { missing: true };
    const { page: retry, discoveries: retries } = await newPage({}, unavailable);
    await retry.goto(`${origin}/#/pages/print-center/index`);
    await expect(connectionFor(retry).getByRole('alert')).toContainText('尚未设置默认打印电脑');
    await expect.poll(() => retries.length).toBe(1);
    assert.equal(await storedPairMatches(retry, null), true, 'a failed discovery stores no credential');
    unavailable.missing = false;
    await connectionFor(retry).getByRole('button', { name: '重新连接打印电脑' }).click();
    await expect(connectionFor(retry)).toContainText('店里打印电脑');
    await expect.poll(() => storedPairMatches(retry, automatic.client)).toBe(true);

    const pendingId = 'remote-existing-task-00000001';
    const { page: pending, discoveries: pendingDiscoveries } = await newPage({
      warehouse_remote_print_pair_v1: replacement.client,
      warehouse_remote_print_pending_v1: { id: pendingId, noteId: 1 }
    });
    await pending.goto(`${origin}/#/pages/print-center/index`);
    await expect(connectionFor(pending)).toContainText('另一台打印电脑');
    assert.equal(await storedPairMatches(pending, replacement.client), true, 'unresolved work keeps its original computer rather than switching to the default');
    assert.equal(pendingDiscoveries.length, 0);
    assert.equal(await pending.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('warehouse_remote_print_pending_v1'));
      return (stored?.data ?? stored)?.id;
    }), pendingId);
    const { page: lost, discoveries: lostDiscoveries } = await newPage({
      warehouse_remote_print_pending_v1: { id: pendingId, noteId: 1 }
    });
    await lost.goto(`${origin}/#/pages/print-center/index`);
    await expect(connectionFor(lost).getByRole('alert')).toContainText('网络原任务尚未确认');
    assert.equal(lostDiscoveries.length, 0, 'an unresolved task with missing credentials never binds a different computer');
    assert.equal(JSON.parse(fs.readFileSync(process.env.WAREHOUSE_REMOTE_PRINT_FILE, 'utf8')).jobs.length, 0, 'connection operations do not enqueue physical printing');
    assert.deepEqual(submitted, [], 'connecting a print computer never submits a document');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ build: built ? 'built-h5' : 'source', automaticConnection: true, noCodeOrScan: true, persistedAfterReload: true, expiredConnectionRecovered: true, discoveryFailureRetry: true, unresolvedTaskKeepsOriginalComputer: true, addressCredentialRemoved: true, layoutWidths: [320, 390, 768, 1024, 1280], physicalPrints: 0, errors }));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
