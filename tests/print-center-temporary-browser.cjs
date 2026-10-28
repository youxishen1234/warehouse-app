const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-temporary-print-browser-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(directory, 'backups');
  process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.PRINT_WEB_DIR || 'release/print-center-01a1211e/web');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('../backend/db');
  const app = require('../backend/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PRINT_BROWSER_EXECUTABLE ? { executablePath: process.env.PRINT_BROWSER_EXECUTABLE } : {});
  const artifacts = path.resolve(process.env.PRINT_ARTIFACTS || 'release/print-center-01a1211e/check');
  fs.mkdirSync(artifacts, { recursive: true });
  const errors = [];
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'zh-CN' });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin || !/^https?:$/.test(url.protocol)) return route.continue();
      if (!url.pathname.startsWith('/api/')) return route.abort();
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      return route.fulfill({ response });
    });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    const button = name => page.getByRole('button', { name, exact: true });
    await page.goto(origin + '/#/pages/print-center/index');
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(artifacts, 'temporary-print-home.png'), fullPage: true });
    await button('临时打印').click();
    await expect(page.getByText(/临时打印：不核对库存/)).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'temporary-print-form.png'), fullPage: true });
    await page.getByLabel('收货单位', { exact: true }).fill('临时打印客户');
    await page.getByLabel('第1项产品名称').fill('未入库纸箱');
    await page.getByLabel('第1项规格尺寸').fill('300x200x100');
    await page.getByLabel('第1项数量').fill('50');
    await page.getByLabel('第1项单价').fill('2.5');
    await page.getByLabel('送货人', { exact: true }).fill('张师傅');
    await button('保存并临时打印').click();

    const dialog = page.getByRole('dialog', { name: '送货单预览' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/临时打印：未核对库存/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: '打印送货单', exact: true })).toBeEnabled();
    const notes = db.listPrintNotes();
    assert.equal(notes.length, 1, 'temporary print saves the delivery note');
    assert.ok(notes[0].temporary_print_at > 0, 'temporary print is recorded on the note');
    assert.equal(notes[0].outbound_at, undefined, 'temporary print does not mark the note outbound');
    assert.equal(db.listTx().length, 0, 'temporary print creates no stock transaction');
    await page.screenshot({ path: path.join(artifacts, 'temporary-print-preview.png'), fullPage: true });
    await dialog.getByRole('button', { name: '返回单据', exact: true }).click();
    await expect(page.getByText('临时打印', { exact: true }).first()).toBeVisible();
    await button('再次打印').click();
    await expect(dialog.getByRole('button', { name: '打印送货单', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: '返回单据', exact: true }).click();
    await button('历史单据').click();
    await expect(page.getByText(/临时打印/).first()).toBeVisible();
    await page.getByRole('button', { name: /查看详情/ }).click();
    await expect(page.getByText(/临时打印单据：未核对库存/)).toBeVisible();
    assert.equal(db.listTx().length, 0, 'reprint and history never create stock transactions');
    await button('删除单据').click();
    await expect(page.locator('.taro__modal .taro-model__confirm')).toBeVisible();
    await page.locator('.taro__modal .taro-model__confirm').click();
    await expect(page.getByText(/送货单 .* 已删除/)).toBeVisible();
    assert.equal(db.listPrintNotes().length, 0, 'deleted temporary notes disappear from the print center');
    assert.ok(JSON.parse(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE)).print_notes[0].deleted_at > 0, 'deleted notes remain in the backup as soft-deleted records');
    await page.screenshot({ path: path.join(artifacts, 'temporary-print-deleted.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ temporaryPrint: 'passed', saved: notes[0].number, artifacts }));
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(artifacts, 'temporary-print-failure.png'), fullPage: true }); console.error((await page.locator('body').innerText()).slice(0, 2200)); }
    throw error;
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
