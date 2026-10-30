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
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const requests = [], errors = [];
  let unhealthy = false;
  await context.addInitScript(() => {
    localStorage.setItem('sg_custom_base', JSON.stringify({ data: 'http://152.136.100.200:4000' }));
    window.Capacitor = {
      Plugins: {
        CapacitorUpdater: {
          current: async () => ({
            bundle: { version: '20261027025127' },
            native: '1.1.137'
          })
        }
      }
    };
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
    await expect(page.getByText('当前版本 1.1.137', { exact: true })).toBeVisible();
    await expect(page.getByText('20261027025127', { exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sg_custom_base')).data), 'https://youxishen.online');
    assert.equal(requests.some(item => item.path === '/api/stats'), false, 'connection must not depend on business statistics');
    const before = await page.evaluate(() => { window.stallHealth = true; return window.healthProbeCount; });
    await page.getByLabel('刷新连接状态', { exact: true }).click();
    await page.getByLabel('刷新连接状态', { exact: true }).click({ clickCount: 3 });
    await page.getByText('连接超时', { exact: true }).waitFor();
    await page.getByText('连接超时，请检查网络后重试', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.healthProbeCount), before + 1, 'repeated clicks share one pending probe');
    await page.evaluate(() => { window.stallHealth = false; window.dispatchEvent(new Event('online')); });
    await page.getByText('已连接', { exact: true }).waitFor();
    unhealthy = true;
    await page.getByLabel('刷新连接状态', { exact: true }).click();
    await page.getByText('连接异常', { exact: true }).waitFor();
    await page.getByText('服务器暂时不可用（HTTP 503），请稍后重试', { exact: true }).waitFor();
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const profile = await page.locator('[class*="heroTop"]').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const copy = element.querySelector('[class*="heroCopy"]').getBoundingClientRect();
        const badge = element.querySelector('[aria-label="刷新连接状态"]').getBoundingClientRect();
        return { right: bounds.right, copyWidth: copy.width, badgeRight: badge.right };
      });
      assert.ok(profile.copyWidth >= 60 && profile.badgeRight <= profile.right + 1, 'profile name and status stay inside the card');
    }
    unhealthy = false;
    await page.getByLabel('刷新连接状态', { exact: true }).click();
    await page.getByText('已连接', { exact: true }).waitFor();
    await context.setOffline(true);
    await page.getByLabel('刷新连接状态', { exact: true }).click();
    await page.getByText('网络未连接', { exact: true }).waitFor();
    await context.setOffline(false);
    await page.getByText('已连接', { exact: true }).waitFor();
    await page.getByText('连接设置', { exact: true }).locator('xpath=ancestor::taro-button-core[1]').click();
    await page.getByText('测试连接', { exact: true }).click();
    await page.getByText('连接成功 ✓ 服务器可以正常访问', { exact: true }).waitFor();
    await expect(page.getByText('已连接', { exact: true })).toBeVisible();
    await page.getByText('取消', { exact: true }).click();
    await page.evaluate(() => {
      window.__openedDownloadUrl = '';
      window.open = url => {
        window.__openedDownloadUrl = String(url);
        return {};
      };
    });
    await page.route('**/download/ipa.json', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: '/download/shuguang-1.1.178-311-958ca3c01954.ipa' })
    }));
    await page.getByText('下载安装包', { exact: true }).locator('xpath=ancestor::taro-button-core[1]').click();
    await expect(page.getByText(/需要使用与手机匹配的开发者证书签名安装/)).toBeVisible();
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const dialog = await page.locator('[class*="ipaDialog"]').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const buttons = [...element.querySelectorAll('taro-button-core')].map(button => button.getBoundingClientRect());
        return { left: bounds.left, right: bounds.right, viewport: innerWidth, buttons: buttons.map(button => ({ left: button.left, right: button.right })) };
      });
      assert.ok(dialog.left >= 0 && dialog.right <= dialog.viewport + 1, 'install dialog stays inside the phone viewport');
      assert.ok(dialog.buttons.every(button => button.left >= dialog.left && button.right <= dialog.right + 1), 'install dialog buttons stay inside the dialog');
    }
    await page.getByText('打开下载页', { exact: true }).click();
    assert.equal(await page.evaluate(() => window.__openedDownloadUrl), 'https://youxishen.online/download/');
    await page.getByText('直接下载 IPA', { exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__openedDownloadUrl))
      .toBe('https://youxishen.online/download/shuguang-1.1.178-311-958ca3c01954.ipa');
    assert(requests.every(item => item.origin === 'https://youxishen.online'), 'never contact retired IP');
    assert.deepEqual(errors, []);
    console.log('Mine connection: legacy migration, bounded bridge timeout, offline recovery, address test and iOS package navigation passed.');
  } finally {
    await context.unrouteAll({ behavior: 'wait' });
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
