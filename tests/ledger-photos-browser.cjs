const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-photo-browser-'));
  const artifacts = path.resolve('release/ledger-check');
  fs.mkdirSync(artifacts, { recursive: true });
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(dir, 'backups');
  process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.LEDGER_WEB_DIR || 'dist');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const backendRoot = process.env.LEDGER_BACKEND_ROOT ? path.resolve(process.env.LEDGER_BACKEND_ROOT) : path.resolve(__dirname, '../backend');
  if (process.env.LEDGER_BACKEND_ROOT) {
    process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(dir, 'accounts.json');
    process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(dir, 'dimensions.json');
    fs.writeFileSync(process.env.WAREHOUSE_ACCOUNTS_FILE, JSON.stringify({ users: [{ id: 'test-admin', username: 'isolated-admin', role: 'admin', disabled: false }], events: [] }));
  }
  const db = require(path.join(backendRoot, 'db'));
  const customer = db.addCustomer({ name: '新星食品（示例）' });
  const product = db.addProduct({ name: '五层瓦楞纸箱', stock: 100, price: 20 });
  db.stockOut(product.id, 5, '示例操作员', '测试样例 · 不是真实业务', customer.id);
  const receivable = db.listLedger()[0];
  const income = db.addLedger({ type: 'income', amount: 1280, remark: '现金收入（示例）' });
  const before = { stock: db.getProduct(product.id).stock, debt: db.getCustomer(customer.id).debt, amounts: db.listLedger().map(row => row.amount) };
  const app = require(path.join(backendRoot, 'server'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let page;
  const errors = [];
  try {
    const fixture = await browser.newPage({ viewport: { width: 640, height: 820 }, deviceScaleFactor: 1 });
    const fixtures = [];
    for (const [index, title] of ['签收单 · 正面', '签收单 · 背面', '送货单', '收款凭证'].entries()) {
      await fixture.setContent(`<html lang="zh"><body style="margin:0;background:#e9e8df;padding:24px;font:16px 'Microsoft YaHei',sans-serif;color:#344139"><div style="padding:40px 32px;height:680px;background:${index === 2 ? '#fdf1f0' : '#fffffb'};border:1px solid #d7dacd;box-shadow:0 3px 10px #bcc0b3"><small style="letter-spacing:4px;color:#86917b">曙光库存 · 功能演示</small><h1 style="text-align:center;font-size:28px;font-weight:500;margin:42px 0 15px">${title}</h1><p style="text-align:center;color:#abb09e;font-size:12px">仅为测试样张，不代表真实签收或收款</p><p style="margin-top:40px">客户：新星食品（示例）</p><p>单号：DEMO-00001</p><table style="width:100%;border-collapse:collapse;margin:26px 0;border:1px solid #9fae99"><tr style="background:#edf1e8"><th style="padding:16px">货物名称</th><th>数量</th><th>金额</th></tr><tr><td style="padding:22px 10px">五层瓦楞纸箱</td><td>5 个</td><td>100.00</td></tr><tr><td colspan="3" style="height:100px;border-top:1px solid #d7dfd0"></td></tr></table><p style="text-align:right">合计：¥100.00</p><p style="margin-top:55px;color:#8d9983">签名位置（示例留空）：________________</p><p style="font-size:11px;color:#a3aa9b;margin-top:28px">图片上传不等于已收款，请另行登记实际收款。</p></div></body></html>`);
      const filename = path.join(dir, `sample-${index + 1}.png`);
      await fixture.screenshot({ path: filename }); fixtures.push(filename);
    }
    await fixture.close();
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Shanghai', acceptDownloads: true });
    page.setDefaultTimeout(18000);
    page.on('pageerror', error => errors.push(error.message));
    let dropCommits = false; let failContent = false;
    const attempts = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      if (!url.pathname.startsWith('/api/')) return route.abort();
      if (failContent && url.pathname.endsWith('/content')) {
        failContent = false;
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, message: '示例原图加载失败，请重试' }) });
      }
      if (dropCommits && url.pathname.includes('/sync/receipt/')) return route.abort();
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      if (route.request().method() === 'POST' && url.pathname.endsWith('/attachments')) {
        attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
        if (dropCommits) return route.abort();
      }
      return route.fulfill({ response });
    });
    const rows = page.locator('[class*="__item___"]');
    const draftRows = page.locator('[class*="__draft___"]');
    const photos = page.locator('[class*="__photoCard___"]');
    const sheet = page.getByRole('dialog', { name: '流水详情', exact: true });
    const add = async (name, files) => {
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name, exact: true }).click();
      await (await chooser).setFiles(files);
    };
    if (process.env.LEDGER_BUSINESS_ENTRY === '1') {
      await page.goto(`${origin}/#/pages/business-center/index`);
      await page.getByText('查看账单流水', { exact: true }).click();
    } else await page.goto(`${origin}/#/pages/ledger/index`);
    await expect(rows).toHaveCount(2);
    await rows.filter({ hasText: '新星食品（示例）' }).click();
    await expect(page.getByText('单据凭证', { exact: true })).toBeVisible();
    await add('添加签收单照片', [fixtures[0], fixtures[1]]);
    await expect(draftRows).toHaveCount(2);
    await page.getByText('待上传 2 张', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'ledger-photos-pending.png') });

    dropCommits = true;
    await page.getByRole('button', { name: '上传 2 张照片', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试上传', exact: true })).toBeVisible({ timeout: 45000 });
    await expect(draftRows).toHaveCount(2);
    assert.equal(db.getLedgerAttachments(receivable.id).length, 1, 'server committed even though the response was lost');
    const storage = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes('pending_writes')))));
    assert.ok(storage.length < 2048 && !storage.includes('base64'), 'retry metadata must not persist private photo bytes');
    assert.equal(new Set(attempts.map(item => item.key)).size, 1, 'automatic retries reuse a key');
    dropCommits = false;
    await page.getByRole('button', { name: '重试上传', exact: true }).click();
    await expect(draftRows).toHaveCount(0);
    await expect(photos).toHaveCount(2);
    assert.equal(db.getLedgerAttachments(receivable.id).length, 2, 'manual retry does not duplicate the uncertain first upload');

    await page.getByRole('button', { name: '送货单', exact: true }).click();
    await add('添加送货单照片', [fixtures[2]]);
    await expect(draftRows).toHaveCount(1);
    await page.getByRole('button', { name: '关闭流水详情', exact: true }).click();
    await rows.filter({ hasText: '现金收入（示例）' }).click();
    await expect(draftRows).toHaveCount(0);
    await page.getByRole('button', { name: '关闭流水详情', exact: true }).click();
    await rows.filter({ hasText: '新星食品（示例）' }).click();
    await expect(draftRows).toHaveCount(1);
    await page.getByRole('button', { name: '上传 1 张照片', exact: true }).click();
    await expect(photos).toHaveCount(3);
    await expect(draftRows).toHaveCount(0);
    await page.getByRole('button', { name: '收款凭证', exact: true }).click();
    await add('添加收款凭证照片', [fixtures[3]]);
    await expect(draftRows).toHaveCount(1);
    await page.getByRole('button', { name: '上传 1 张照片', exact: true }).click();
    await expect(photos).toHaveCount(4);
    await expect(draftRows).toHaveCount(0);
    await expect(photos.locator('img')).toHaveCount(4);
    await photos.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await expect(page.getByText('上传结果未确认，表单已保留；请勿更改内容，联网后重试', { exact: true })).not.toBeVisible();
    await page.getByText('单据凭证', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, 'ledger-photos-mobile.png') });
    await page.setViewportSize({ width: 320, height: 740 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(artifacts, 'ledger-photos-small.png') });
    await page.setViewportSize({ width: 1440, height: 1080 });
    await sheet.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(artifacts, 'ledger-photos-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });

    failContent = true;
    await photos.first().click();
    await expect(page.getByRole('button', { name: '重新加载原图', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重新加载原图', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: '凭证原图', exact: true });
    await expect(viewer.locator('img')).toHaveCount(1);
    await viewer.locator('img').evaluate(image => image.decode());
    await page.screenshot({ path: path.join(artifacts, 'ledger-photo-viewer.png') });
    await page.getByRole('button', { name: '放大查看', exact: true }).click();
    await expect(page.getByRole('button', { name: '适应屏幕', exact: true })).toBeVisible();
    const imageWidth = await viewer.locator('taro-image-core').evaluate(element => element.getBoundingClientRect().width);
    assert.ok(imageWidth > 1000, 'document can be enlarged and scrolled');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存原图', exact: true }).click();
    const download = await downloadEvent;
    const downloaded = path.join(dir, 'saved-original.png'); await download.saveAs(downloaded);
    assert.deepEqual(fs.readFileSync(downloaded), fs.readFileSync(fixtures[0]));
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(sheet).toBeVisible();

    await page.getByRole('button', { name: '签收单', exact: true }).click();
    await add('添加签收单照片', [fixtures[0]]);
    await expect(draftRows).toHaveCount(1);
    await page.getByRole('button', { name: '上传 1 张照片', exact: true }).click();
    await expect(draftRows).toHaveCount(0);
    await expect(photos).toHaveCount(4);
    await page.reload();
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: '新星食品（示例）' })).toContainText('凭证 4 张');
    await rows.filter({ hasText: '新星食品（示例）' }).click();
    await expect(photos).toHaveCount(4);
    assert.equal(db.getLedgerAttachments(income.id).length, 0);
    assert.deepEqual({ stock: db.getProduct(product.id).stock, debt: db.getCustomer(customer.id).debt, amounts: db.listLedger().map(row => row.amount) }, before);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Browser errors:', JSON.stringify(errors));
    if (page) { await page.screenshot({ path: path.join(artifacts, 'ledger-photos-failure.png') }); fs.writeFileSync(path.join(artifacts, 'ledger-photos-failure.txt'), await page.locator('body').innerText()); }
    throw error;
  } finally {
    try {
      // Finish proxy fetches while their browser context is still available.
      if (page) await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log('Ledger photo browser checks passed: original upload, uncertain retry, multiple types/pages, draft retention, reload, zoom, download, stable amounts.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
