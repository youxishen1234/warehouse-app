const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-connection-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temp, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temp, 'backups');
  process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.CONNECTION_WEB_DIR || process.env.TARO_OUTPUT_DIR || 'dist');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const server = require('../backend/server').listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const requests = [], errors = [];
  let unhealthy = false;
  await context.addInitScript(() => {
    localStorage.setItem('sg_custom_base', JSON.stringify({ data: 'http://152.136.100.200:4000' }));
    const original = window.fetch.bind(window);
    window.healthProbeCount = 0;
    window.fetch = (url, options) => {
      if (String(url).endsWith('/api/health')) {
        window.healthProbeCount += 1;
        // Reproduce a native bridge that never settles, even when aborted.
        if (window.stallHealth) return new Promise(() => {});
      }
      return original(url, options);
    };
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    requests.push({ origin: url.origin, path: url.pathname });
    if (url.origin !== 'https://youxishen.online' || !url.pathname.startsWith('/api/')) return route.abort();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization, X-Warehouse-Device' };
    if (url.pathname === '/api/stats' || (unhealthy && url.pathname === '/api/health')) {
      return route.fulfill({ status: 503, headers, contentType: 'application/json', body: JSON.stringify({ success: false }) });
    }
    const response = await route.fetch({ url: origin + url.pathname + url.search });
    return route.fulfill({ response, headers: { ...response.headers(), ...headers } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(12000);
  try {
    await page.goto(origin + '/#/pages/mine/index');
    await page.getByText('已连接', { exact: true }).waitFor();
    await page.locator('.team-boot').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sg_custom_base')).data), 'https://youxishen.online');
    assert.equal(requests.some(item => item.path === '/api/stats'), false, 'connection must not depend on business statistics');
    const before = await page.evaluate(() => { window.stallHealth = true; return window.healthProbeCount; });
    await page.getByText('已连接', { exact: true }).click();
    await page.getByText('检测中', { exact: true }).click({ clickCount: 3 });
    await page.getByText('连接超时', { exact: true }).waitFor();
    await page.getByText('连接超时，请检查网络后重试', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.healthProbeCount), before + 1, 'repeated clicks share one pending probe');
    await page.evaluate(() => { window.stallHealth = false; window.dispatchEvent(new Event('online')); });
    await page.getByText('已连接', { exact: true }).waitFor();
    unhealthy = true;
    await page.getByText('已连接', { exact: true }).click();
    await page.getByText('连接异常', { exact: true }).waitFor();
    await page.getByText('服务器暂时不可用（HTTP 503），请稍后重试', { exact: true }).waitFor();
    unhealthy = false;
    await page.getByText('连接异常', { exact: true }).click();
    await page.getByText('已连接', { exact: true }).waitFor();
    await context.setOffline(true);
    await page.getByText('已连接', { exact: true }).click();
    await page.getByText('网络未连接', { exact: true }).waitFor();
    await context.setOffline(false);
    await page.getByText('已连接', { exact: true }).waitFor();
    await page.getByText('当前服务节点', { exact: true }).click();
    await page.getByText('测试连接', { exact: true }).click();
    await page.getByText('连接成功 ✓ 服务器可以正常访问', { exact: true }).waitFor();
    await expect(page.getByText('已连接', { exact: true })).toBeVisible();
    assert(requests.every(item => item.origin === 'https://youxishen.online'), 'never contact retired IP');
    assert.deepEqual(errors, []);
    console.log('Mine connection: legacy migration, no business dependency, bounded bridge timeout, deduplication, HTTP error, offline recovery and address test passed.');
  } finally {
    await context.unrouteAll({ behavior: 'wait' });
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
