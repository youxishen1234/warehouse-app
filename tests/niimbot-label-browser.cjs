const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium, webkit, expect } = require('@playwright/test');
const jsQR = require('jsqr');
const Protocol = require('../prototypes/niimbot-protocol');

const root = path.resolve(process.env.NIIMBOT_WEB_DIR || 'release/niimbot-final-check/qr-test');
const artifacts = path.resolve(process.env.NIIMBOT_CHECK_DIR || 'release/niimbot-final-check/screenshots');

async function mock(page, config) {
  await page.addInitScript(config => {
    const listeners = {};
    window.printerTest = { writes: [], connects: 0, disconnects: 0, statusReads: 0 };
    const frame = (command, data) => {
      const body = [command, data.length, ...data];
      return [0x55, 0x55, ...body, body.reduce((a, b) => a ^ b, 0), 0xaa, 0xaa];
    };
    const emit = (command, data) => {
      const packet = frame(command, data);
      // Exercise the same fragmentation handled by CoreBluetooth notifications.
      listeners.data({ bytes: packet.slice(0, 5) });
      listeners.data({ bytes: packet.slice(5) });
    };
    const plugin = {
      async addListener(name, listener) {
        if (config.listenerError) throw new Error('Native plugin unavailable');
        await new Promise(resolve => setTimeout(resolve, 20));
        listeners[name] = listener;
        return { remove: async () => { delete listeners[name]; } };
      },
      async scan() {
        assertReady();
        if (config.scanError) throw new Error('请在 iPhone 设置中允许曙光使用蓝牙');
        return { devices: config.empty ? [] : [{ id: 'k3-test', name: 'K3-I911020404' }] };
      },
      async connect() { window.printerTest.connects++; },
      async disconnect() {
        window.printerTest.disconnects++;
        if (listeners.disconnected) listeners.disconnected({ message: 'disconnected' });
      },
      async write({ data, type }) {
        window.printerTest.writes.push({ data, type });
        if (config.writeError) throw new Error('打印机写入失败');
        const packet = data[0] === 3 ? data.slice(1) : data;
        const command = packet[2];
        const payload = packet.slice(4, -3);
        if (command === 0x85 || command === 0x84) {
          if (config.paperError) emit(0xdb, [2]);
          return;
        }
        if (command === 0x40) {
          emit(0x40 + payload[0], payload[0] === 8 ? (config.model || [0x13, 0]) : [3]);
          return;
        }
        if (command === 0xa3) {
          const first = window.printerTest.statusReads++ === 0;
          emit(0xb3, first ? [0, 0, 0, 0] : [0, 1, 100, 100]);
          return;
        }
        const responses = { 0xc1: 0xc2, 0x21: 0x31, 0x23: 0x33, 1: 2, 3: 4, 0x13: 0x14, 0x86: 0xd3, 0xe3: 0xe4, 0xf3: 0xf4, 0xda: 0xd0 };
        if (responses[command]) emit(responses[command], [config.rejectCommand === command ? 0 : 1]);
      },
    };
    function assertReady() {
      if (!listeners.data || !listeners.disconnected) throw new Error('Notification subscription race');
    }
    window.CapacitorPlatforms = {
      currentPlatform: {
        getPlatform: () => 'ios',
        isNativePlatform: () => true,
        isPluginAvailable: () => config.available !== false,
        registerPlugin: () => plugin,
      },
      platforms: new Map(),
    };
    window.Capacitor = { Plugins: { NiimbotPrinter: plugin } };
  }, config);
}

async function open(browser, origin, config = {}, native = true) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (native) await mock(page, config);
  await page.goto(origin + '/spec-test.html' + (native ? '?client=app' : ''));
  await page.getByLabel('对方公司名称').fill('睿溪包装有限公司');
  await page.getByLabel('规格（请带尺寸单位）').fill('40 × 40 × 30 cm');
  await page.locator('[name=quantity]').fill('600');
  await expect(page.locator('#qr')).toHaveAttribute('src', /^data:/);
  return { page, errors };
}

async function connect(page) {
  await page.locator('#printer-scan').click();
  await expect(page.locator('#printer-device')).toHaveValue('k3-test');
  await expect(page.locator('#printer-connect')).toBeEnabled();
  await page.locator('#printer-connect').click();
}

function decodeRaster(writes) {
  const rgba = new Uint8ClampedArray(560 * 800 * 4).fill(255);
  let rows = 0;
  for (const { data } of writes) {
    const decoded = Protocol.parsePackets(data).packets[0];
    if (!decoded || decoded.command !== 0x85) continue;
    const y = Protocol.asUInt16(decoded.data);
    const bitmap = decoded.data.slice(6);
    assert.equal(bitmap.length, 70);
    for (let x = 0; x < 560; x++) {
      if (!(bitmap[x >> 3] & (0x80 >> (x & 7)))) continue;
      const offset = (y * 560 + x) * 4;
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 0;
    }
    rows++;
  }
  assert.equal(rows, 800);
  const qr = jsQR(rgba, 560, 800);
  assert.ok(qr, '1-bit data sent to K3 contains a decodable QR');
  return new URLSearchParams(new URL(qr.data).hash.slice(1));
}

async function verify(browser, origin, name) {
  let result = await open(browser, origin);
  let page = result.page;
  try {
    await connect(page);
    await expect(page.locator('#direct-print')).toBeEnabled();
    for (const kind of ['成品', '纸板']) {
      await page.getByRole('button', { name: kind + '标签', exact: true }).click();
      await page.evaluate(() => { window.printerTest.writes = []; window.printerTest.statusReads = 0; });
      await page.locator('#direct-print').click();
      await expect(page.locator('#printer-status')).toContainText('打印机已确认完成', { timeout: 15000 });
      await expect(page.locator('#printer-scan')).toBeEnabled();
      const writes = await page.evaluate(() => window.printerTest.writes);
      const commands = writes.map(({ data }) => Protocol.parsePackets(data).packets[0]?.command);
      assert.deepEqual(commands.slice(0, 8), [0x40, 0x40, 0x21, 0x23, 1, 3, 0x13, 0xa3]);
      assert.ok(!commands.includes(0x20), 'V4 must not issue old D11 PrintClear');
      assert.equal(commands.at(-1), 0xf3);
      assert.equal(commands.filter(command => command === 0x86).length, 4);
      const qr = decodeRaster(writes);
      assert.equal(qr.get('name'), kind);
      assert.equal(qr.get('unit'), kind === '纸板' ? '张' : '个');
      assert.equal(qr.get('company'), '睿溪包装有限公司');
      assert.equal(qr.get('quantity'), '600');
    }
    await page.screenshot({ path: path.join(artifacts, name + '-native.png'), fullPage: true });
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }

  for (const [config, message] of [
    [{ empty: true }, '没有找到打印机'],
    [{ scanError: true }, '允许曙光使用蓝牙'],
    [{ model: [0xff, 0xff] }, '目前仅接入精臣 K3'],
    [{ writeError: true }, '打印机写入失败'],
    [{ rejectCommand: 0xc1 }, '拒绝蓝牙握手'],
    [{ paperError: true }, '打印机缺纸'],
    [{ rejectCommand: 0x13 }, '拒绝命令'],
  ]) {
    result = await open(browser, origin, config);
    page = result.page;
    try {
      await page.locator('#printer-scan').click();
      if (!config.empty && !config.scanError) {
        await expect(page.locator('#printer-connect')).toBeEnabled();
        await page.locator('#printer-connect').click();
        if (config.paperError || config.rejectCommand === 0x13) {
          await expect(page.locator('#direct-print')).toBeEnabled();
          await page.locator('#direct-print').click();
        }
      }
      await expect(page.locator('#printer-status')).toContainText(message);
      await expect(page.locator('#direct-print')).toBeDisabled();
      await expect(page.locator('#printer-scan')).toBeEnabled();
      assert.deepEqual(result.errors, []);
    } finally { await page.close(); }
  }
  for (const [config, native] of [[{ available: false }, true], [{}, false]]) {
    result = await open(browser, origin, config, native);
    page = result.page;
    try {
      await expect(page.locator('#printer-tools')).toBeHidden();
      await page.evaluate(() => { window.printed = false; window.print = () => { window.printed = true; }; });
      await page.locator('#print').click();
      await expect.poll(() => page.evaluate(() => window.printed)).toBe(true);
      assert.deepEqual(result.errors, []);
    } finally { await page.close(); }
  }
  console.log(name + ': mocked K3 scan, connect, V4 printing, raster QR, failures and legacy fallback passed.');
}

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const app = express();
  app.use(express.static(root));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
      const browser = await engine.launch();
      try { await verify(browser, 'http://127.0.0.1:' + server.address().port, name); }
      finally { await browser.close(); }
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
