const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

const dateValue = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const webRoot = path.resolve(process.env.BLE630K_WEB_DIR || 'release/bluetooth630k-20261027/web');
const artifacts = path.resolve(process.env.PRINT_ARTIFACTS || 'release/bluetooth630k-20261027/built-ble-ui');

async function assertResponsive(dialog, page, width, file) {
  await page.setViewportSize({ width, height: 844 });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(100);
  const metrics = await dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left, right: rect.right, viewportWidth: innerWidth,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth
    };
  });
  assert.ok(metrics.left >= -1 && metrics.right <= metrics.viewportWidth + 1, `preview dialog stays within ${width}px viewport: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `preview dialog has no horizontal overflow at ${width}px: ${JSON.stringify(metrics)}`);
  const overflow = await dialog.locator('button:visible').evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    return {
      text: button.innerText.trim(), left: rect.left, right: rect.right,
      clientWidth: button.clientWidth, scrollWidth: button.scrollWidth,
      clientHeight: button.clientHeight, scrollHeight: button.scrollHeight,
      containsPaperPreview: Boolean(button.querySelector('iframe[title="送货单纸张预览"]'))
    };
  }).filter(button => button.left < -1 || button.right > innerWidth + 1
    || (!button.containsPaperPreview && (button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1))));
  assert.deepEqual(overflow, [], `visible button content stays in bounds at ${width}px`);
  await page.screenshot({ path: file, fullPage: true });
  return metrics;
}

async function main() {
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `built H5 does not exist: ${webRoot}`);
  fs.mkdirSync(artifacts, { recursive: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bluetooth-630k-built-browser-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  process.env.WAREHOUSE_REMOTE_PRINT_FILE = path.join(directory, 'remote-print.json');
  process.env.WAREHOUSE_WEB_ROOT = webRoot;
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));

  let server, browser, page;
  const errors = [];
  const externalBlocked = [];
  const printSubmissions = [];
  try {
    const db = require('../backend/db');
    const remotePrint = require('../backend/remote-print');
    const remoteStore = remotePrint.createStore(process.env.WAREHOUSE_REMOTE_PRINT_FILE);
    const pairing = remoteStore.register('630K网络打印测试电脑', 'EPSON LQ-630K ESC/P2');
    remoteStore.claim(pairing.agent, true);
    const customer = db.addCustomer({ name: '630K 内置预览验收客户', contact: '测试联系人', phone: '13800000000', address: '隔离测试地址' });
    const product = db.addProduct({ name: '630K 内置预览测试纸箱', specification: '400×300×200', unit: '个', stock: 50, price: 2 });
    const saved = db.savePrintNote({
      company: '曙光测试公司', customer_id: customer.id, customer_name: customer.name,
      address: customer.address, phone: customer.phone, receiver: customer.contact, sender: '测试送货人',
      date: dateValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)), paper: '241-93',
      items: [{ product_id: product.id, name: product.name, specification: product.specification, unit: product.unit, quantity: 12, price: product.price, remark: 'built preview fixture' }]
    });
    const shipped = db.shipPrintNote(saved.id);
    assert.ok(saved.id && saved.number && shipped.outbound_at, 'fixture creates an outbound delivery note');

    const app = require('../backend/server');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    await context.addInitScript(clientToken => {
      localStorage.setItem('warehouse_remote_print_pair_v1', JSON.stringify({ data: clientToken }));
      localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
      window.__builtBluetoothUiFixture = { nativeCalls: [], printCalls: 0 };
      window.androidBridge = { postMessage(message) { window.__builtBluetoothUiFixture.nativeCalls.push(message); } };
      window.Capacitor = { PluginHeaders: [{
        name: 'BluetoothLe',
        methods: ['initialize', 'requestDevice', 'connect', 'disconnect', 'read', 'write', 'getMtu', 'getDevices', 'getServices', 'startNotifications', 'stopNotifications']
          .map(name => ({ name, rtype: 'promise' }))
      }] };
      window.print = () => { window.__builtBluetoothUiFixture.printCalls++; };
    }, pairing.client);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/remote-print/jobs' && request.method() === 'POST') {
        printSubmissions.push({ method: request.method(), url: request.url() });
        return route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'built UI acceptance blocks print submission' }) });
      }
      if (url.pathname.startsWith('/api/')) {
        const headers = { ...request.headers() };
        delete headers.host; delete headers['content-length']; delete headers['accept-encoding'];
        const response = await fetch(origin + url.pathname + url.search, {
          method: request.method(), headers,
          ...(request.method() === 'GET' || request.method() === 'HEAD' ? {} : { body: request.postDataBuffer() })
        });
        return route.fulfill({
          status: response.status,
          headers: { 'content-type': response.headers.get('content-type') || 'application/json' },
          body: Buffer.from(await response.arrayBuffer())
        });
      }
      if (url.origin === origin) return route.continue();
      if (!/^https?:$/.test(url.protocol)) return route.continue();
      externalBlocked.push(url.href);
      return route.abort();
    });

    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/pages/print-center/index');
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await expect(page.locator('main[data-print-view="home"]')).toBeVisible();
    const runtime = await page.evaluate(() => ({
      native: window.Capacitor?.isNativePlatform?.() ?? false,
      platform: window.Capacitor?.getPlatform?.() ?? 'web',
      bluetoothLe: window.Capacitor?.isPluginAvailable?.('BluetoothLe') ?? false
    }));
    assert.deepEqual(runtime, { native: true, platform: 'android', bluetoothLe: true }, 'built Capacitor core recognizes the Android bridge and BluetoothLe plugin header');

    await page.getByRole('button', { name: '查找单据', exact: true }).click();
    await expect(page.locator('main[data-print-view="history"]')).toBeVisible();
    const historyEntry = page.locator('article').filter({ hasText: saved.number });
    await expect(historyEntry).toContainText(saved.number);
    await expect(historyEntry.getByRole('button', { name: '重新打印', exact: true })).toBeVisible();
    await historyEntry.getByRole('button', { name: '重新打印', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '送货单预览' });
    await expect(preview).toBeVisible();
    const bluetoothChannel = preview.getByRole('button', { name: '630K 蓝牙打印', exact: true });
    const networkChannel = preview.getByRole('button', { name: '网络打印', exact: true });
    await expect(networkChannel).toHaveAttribute('aria-pressed', 'true');
    await expect(bluetoothChannel).toHaveAttribute('aria-pressed', 'false');
    await expect(preview.getByRole('button', { name: '发送到630K', exact: true })).toBeEnabled();
    await bluetoothChannel.click();
    await expect(bluetoothChannel).toHaveAttribute('aria-pressed', 'true');
    await expect(networkChannel).toHaveAttribute('aria-pressed', 'false');
    const bluetoothSection = preview.locator('[data-transport="bluetooth"]');
    await expect(bluetoothSection).toBeVisible();
    await expect(bluetoothSection.getByRole('button', { name: '选择630K打印电脑', exact: true })).toBeEnabled();
    const previewFrame = preview.frameLocator('iframe[title="送货单纸张预览"]');
    await expect(previewFrame.locator('body')).toContainText(customer.name);
    await expect(previewFrame.locator('body')).toContainText(product.name);
    await expect(previewFrame.locator('body')).toContainText('built preview fixture');

    const layout = [];
    for (const width of [320, 390, 768]) {
      layout.push(await assertResponsive(preview, page, width, path.join(artifacts, `built-ble-preview-${width}px.png`)));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await networkChannel.click();
    await expect(networkChannel).toHaveAttribute('aria-pressed', 'true');
    await expect(bluetoothChannel).toHaveAttribute('aria-pressed', 'false');
    await expect(bluetoothSection).toHaveCount(0);
    const remotePanel = preview.locator('details').filter({ hasText: /远程打印到店里/ });
    await expect(remotePanel).toHaveAttribute('open', '');
    const networkAction = preview.getByRole('button', { name: '发送到630K', exact: true });
    await expect(networkAction).toBeEnabled();
    await expect(previewFrame.locator('body')).toContainText(product.name);

    const bridgeCalls = await page.evaluate(() => window.__builtBluetoothUiFixture.nativeCalls.length);
    const printCalls = await page.evaluate(() => window.__builtBluetoothUiFixture.printCalls);
    assert.equal(bridgeCalls, 0, 'the UI-only flow never invokes the native BLE bridge');
    assert.equal(printCalls, 0, 'the UI-only flow never invokes browser printing');
    assert.deepEqual(printSubmissions, [], 'the network send action is never activated');
    assert.deepEqual(errors, [], 'built preview has no page errors');
    console.log(JSON.stringify({
      builtWebRoot: webRoot, artifacts, noteNumber: saved.number, runtime,
      defaultChannel: 'network', explicitBluetoothSelection: true, printerSelectionVisible: true, networkChannelUsable: true,
      layoutWidths: [320, 390, 768], layout, nativeBridgeCalls: bridgeCalls, printCalls, printSubmissions,
      blockedExternalRequests: externalBlocked.length, pageErrors: errors
    }));
  } catch (error) {
    if (page) {
      console.error('built BLE UI body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 3000));
      console.error('built BLE UI URL:', page.url());
      await page.screenshot({ path: path.join(artifacts, 'built-ble-ui-failure.png'), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
