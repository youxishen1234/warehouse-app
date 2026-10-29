const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const QRCode = require('qrcode');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'print-center-home-pairing-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_REMOTE_PRINT_FILE = path.join(directory, 'remote-print.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('../backend/db');
  const store = require('../backend/remote-print').createStore(process.env.WAREHOUSE_REMOTE_PRINT_FILE);
  const pair = store.register('店里打印电脑', 'EPSON LQ-630K ESC/P2');
  const replacement = store.register('另一台打印电脑', 'EPSON LQ-630K ESC/P2');
  store.claim(pair.agent, true);
  const built = !!process.env.PRINT_HOME_WEB_DIR;
  if (built) process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.PRINT_HOME_WEB_DIR);
  const app = built ? require('../backend/server') : require('./helpers/print-center-source.cjs')(db);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const submitted = [];
  const routePage = async context => {
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
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
  const newPage = async (storage = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    await context.addInitScript(({ values, built }) => {
      Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, JSON.stringify(built ? { data: value } : value)));
      if (built) localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
    }, { values: storage, built });
    await routePage(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    return page;
  };
  const storedPairMatches = (page, value) => page.evaluate(expected => {
    try {
      const stored = JSON.parse(localStorage.getItem('warehouse_remote_print_pair_v1'));
      return (stored?.data ?? stored) === expected;
    } catch { return false; }
  }, value);
  const connectionFor = page => page.getByRole('region', { name: '连接打印电脑' });
  try {
    const page = await newPage();
    await page.goto(`${origin}/#/pages/print-center/index?print_pair=${pair.client}`);
    const connection = connectionFor(page);
    await expect(connection).toBeVisible();
    await expect(connection).toContainText('店里打印电脑');
    await expect(connection).toContainText('EPSON LQ-630K ESC/P2');
    await expect(connection).toContainText('电脑在线');
    await expect.poll(() => storedPairMatches(page, pair.client)).toBe(true);
    await expect.poll(() => page.evaluate(() => location.href.includes('print_pair='))).toBe(false);
    await page.reload();
    await expect(connection).toContainText('店里打印电脑');
    await expect(connection).toContainText('电脑在线');
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = await connection.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, overflow: element.scrollWidth > element.clientWidth + 1, width: innerWidth };
      });
      assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1 && !bounds.overflow, `connection remains in ${width}px viewport`);
    }

    const scan = await newPage();
    await scan.goto(`${origin}/#/pages/print-center/index`);
    const scanConnection = connectionFor(scan);
    await expect(scanConnection.getByRole('button', { name: '扫码连接打印电脑' })).toBeEnabled();
    await expect(scanConnection).not.toContainText('请先保存单据');
    const fileChooser = scan.waitForEvent('filechooser');
    await scanConnection.getByRole('button', { name: '扫码连接打印电脑' }).click();
    await (await fileChooser).setFiles({
      name: 'isolated-printer-pair.png', mimeType: 'image/png',
      buffer: await QRCode.toBuffer(`${origin}/#/pages/print-center/index?print_pair=${pair.client}`, { width: 360, margin: 2 })
    });
    await expect(scanConnection).toContainText('店里打印电脑');
    await expect.poll(() => storedPairMatches(scan, pair.client)).toBe(true);

    const invalid = await newPage();
    await invalid.goto(`${origin}/#/pages/print-center/index?print_pair=invalid`);
    await expect(connectionFor(invalid).getByRole('alert')).toContainText('打印连接链接无效');
    await expect.poll(() => storedPairMatches(invalid, null)).toBe(true);
    const rejected = await newPage();
    await rejected.goto(`${origin}/#/pages/print-center/index?print_pair=${'f'.repeat(64)}`);
    await expect(connectionFor(rejected).getByRole('alert')).toContainText('打印配对已失效');
    await expect.poll(() => storedPairMatches(rejected, null)).toBe(true);

    const pendingId = 'remote-existing-task-00000001';
    const pending = await newPage({
      warehouse_remote_print_pair_v1: pair.client,
      warehouse_remote_print_pending_v1: { id: pendingId, noteId: 1 }
    });
    await pending.goto(`${origin}/#/pages/print-center/index?print_pair=${replacement.client}`);
    await expect(connectionFor(pending).getByRole('alert').filter({ hasText: '网络原任务尚未确认' })).toBeVisible();
    assert.equal(await storedPairMatches(pending, pair.client), true, 'unresolved work keeps its original paired computer');
    assert.equal(await pending.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('warehouse_remote_print_pending_v1'));
      return (stored?.data ?? stored)?.id;
    }), pendingId);
    assert.equal(JSON.parse(fs.readFileSync(process.env.WAREHOUSE_REMOTE_PRINT_FILE, 'utf8')).jobs.length, 0, 'connection operations do not enqueue physical printing');
    assert.deepEqual(submitted, [], 'connecting a print computer never submits a document');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ build: built ? 'built-h5' : 'source', pairedOnHome: true, scanWithoutDocument: true, persistedAfterReload: true, invalidLinksRejected: true, unresolvedTaskKeepsOriginalComputer: true, addressCredentialRemoved: true, layoutWidths: [320, 390, 768], physicalPrints: 0, errors }));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
