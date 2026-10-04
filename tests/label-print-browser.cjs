const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium, webkit, expect } = require('@playwright/test');
const jsQR = require('jsqr');

const root = path.resolve(process.env.LABEL_WEB_DIR || 'dist');
const artifacts = path.resolve(process.env.LABEL_CHECK_DIR || 'release/label-hotupdate/check');

async function decode(page) {
  const pixels = await page.locator('#qr').evaluate(async image => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return { data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data), width: canvas.width, height: canvas.height };
  });
  const code = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
  assert.ok(code, 'label QR decodes');
  return new URL(code.data);
}

async function verify(browser, origin, name, native) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      let data = [];
      if (url.pathname.endsWith('/auth/guest')) data = { token: 'test-token', user: { id: 'label-test', username: 'test', role: 'viewer' } };
      if (url.pathname.endsWith('/stats')) data = { todayIn: 0, todayOut: 0, totalProducts: 0, lowStock: 0, totalValue: 0 };
      if (url.pathname.endsWith('/sync')) data = { revision: 1 };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    }
    return url.origin === origin ? route.continue() : route.abort();
  });
  if (native) await page.addInitScript(() => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: {} };
  });
  await page.goto(origin + '/index.html#/pages/home/index');
  await page.getByRole('button', { name: '进入业务中心', exact: true }).click();
  const entry = page.getByRole('button', { name: '进入标签打印', exact: true });
  await expect(entry).toBeVisible();
  if (!native) await page.screenshot({ path: path.join(artifacts, name + '-home.png') });
  await entry.click();
  await page.waitForURL('**/spec-test.html*');
  await expect(page.locator('body')).toHaveAttribute('data-width', '70');
  await page.getByLabel('对方公司名称').fill('曙光测试公司');
  await page.getByLabel('规格（请带尺寸单位）').fill('40×40×30 cm');
  await page.locator('[name=quantity]').fill('600');
  for (const [kind, unit] of [['成品', '个'], ['纸板', '张'], ['成品', '个']]) {
    await page.getByRole('button', { name: kind + '标签', exact: true }).click();
    await expect(page.getByRole('button', { name: kind + '标签', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#label-title')).toHaveText('曙光仓库 · ' + kind + '标签');
    await expect(page.locator('#amount')).toHaveText('600 ' + unit);
    await expect(page.locator('[data-field=company]')).toHaveText('曙光测试公司');
    await expect(page.locator('#qr')).toHaveAttribute('src', /^data:/);
    const code = await decode(page);
    const data = new URLSearchParams(code.hash.slice(1));
    assert.equal(data.get('name'), kind);
    assert.equal(data.get('unit'), unit);
    assert.equal(data.get('quantity'), '600');
    assert.equal(data.get('width'), '70');
    if (native) assert.equal(code.origin, 'https://youxishen.online');
    await page.evaluate(() => { window.printed = false; window.print = () => { window.printed = true; }; });
    await page.locator('#print').click();
    await expect.poll(() => page.evaluate(() => window.printed)).toBe(true);
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.label-types')).toBeHidden();
    await expect(page.locator('.editor')).toBeHidden();
    const box = await page.locator('.label').boundingBox();
    assert.ok(Math.abs(box.width - 70 * 96 / 25.4) < 1);
    assert.ok(Math.abs(box.height - 100 * 96 / 25.4) < 1);
    assert.ok(await page.locator('.label').evaluate(e => e.scrollHeight <= e.clientHeight + 1));
    if (name === 'chromium' && !native) {
      const tag = kind === '成品' ? 'finished' : 'board';
      await page.locator('.label').screenshot({ path: path.join(artifacts, tag + '-70x100.png') });
      const pdf = await page.pdf({ path: path.join(artifacts, tag + '-70x100.pdf'), preferCSSPageSize: true });
      const raw = pdf.toString('latin1');
      assert.equal((raw.match(/\/Type\s*\/Page\b/g) || []).length, 1, 'exactly one label per printed page');
      const dimensions = raw.match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/);
      assert.ok(dimensions);
      assert.ok(Math.abs(Number(dimensions[1]) - 70 * 72 / 25.4) < 1);
      assert.ok(Math.abs(Number(dimensions[2]) - 100 * 72 / 25.4) < 1);
    }
    await page.emulateMedia({ media: 'screen' });
  }
  await page.screenshot({ path: path.join(artifacts, name + (native ? '-native' : '-web') + '-switch.png'), fullPage: true });
  await page.locator('#back').click();
  await page.waitForURL('**/index.html#/pages/business-center/index');
  await expect(page.getByRole('button', { name: '进入标签打印', exact: true })).toBeVisible();
  const params = new URLSearchParams({ view: '1', name: '纸板', company: '带入公司', specification: '120×80 cm', quantity: '30' });
  await page.goto(origin + '/index.html#/pages/qr-test/index?' + params);
  await page.waitForURL('**/spec-test.html*');
  await expect(page.locator('#label-title')).toHaveText('曙光仓库 · 纸板标签');
  await expect(page.locator('[data-field=company]')).toHaveText('带入公司');
  await expect(page.locator('#amount')).toHaveText('30 张');
  await expect(page.locator('.editor')).toBeHidden();
  await page.getByRole('button', { name: '成品标签', exact: true }).click();
  await expect(page.locator('#amount')).toHaveText('30 个');
  assert.deepEqual(errors, []);
  await page.close();
  console.log(name + (native ? ' native' : ' web') + ': home entry, switching, QR data, 70×100 printing, return and prefilled labels passed.');
}

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const app = express();
  app.use('/workspace', express.static(root));
  app.use(express.static(root));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
      const browser = await engine.launch();
      try { await verify(browser, origin, name, false); await verify(browser, origin, name, true); }
      finally { await browser.close(); }
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
