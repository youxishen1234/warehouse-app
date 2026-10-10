const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');

async function main() {
  process.env.TEAM_PREVIEW_PORT = '0';
  const { server, db } = await require('../scripts/team-preview.cjs')();
  const base = `http://127.0.0.1:${server.address().port}`;
  const name = process.env.REPORT_BROWSER === 'webkit' ? 'webkit' : 'chromium';
  const browser = await (name === 'webkit' ? webkit : chromium).launch();
  const artifactDir = path.resolve('release/reporting-check', name);
  fs.mkdirSync(artifactDir, { recursive: true });
  let page;
  const errors = [];
  try {
    const product = db.addProduct({ name: '报表回归商品', unit: '件', price: 2.5, stock: 0 });
    db.transact({ id: 'report-test', username: 'report-test' }, 'report-fixture-001', 'report-fixture', String(db.revision()), 'test seed', () => {
      for (let index = 1; index <= 405; index++) {
        db.stockIn(product.id, 1, 'report-test', `report-${index}`, null, { specification: `report-${index}` });
      }
      db.addLedger({ type: 'income', amount: 7.25, remark: '=formula-test,"quoted"\nline two' });
      db.addLedger({ type: 'expense', amount: 2.5, remark: 'expense-test' });
      return { count: 405 };
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const apiOrigins = new Set(['http://152.136.100.200', 'https://youxishen.online']);
    const pageRequests = [];
    let failSecondPage = true;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/transactions' && url.searchParams.has('page')) {
        pageRequests.push(Number(url.searchParams.get('page')));
        if (url.searchParams.get('page') === '2' && failSecondPage) {
          failSecondPage = false;
          return route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ success: false, message: '本次加载失败，请重试' }) });
        }
      }
      if (url.origin === base || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      if (apiOrigins.has(url.origin) && url.pathname.startsWith('/api/')) {
        const response = await route.fetch({ url: base + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization, If-Match, Idempotency-Key, X-Warehouse-Device', 'access-control-expose-headers': 'X-Warehouse-Revision' } });
      }
      return route.abort();
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));

    // Delivery-note printing is exercised in print-center-browser.cjs.
    await page.goto(base + '/pages/ledger/index');
    await page.getByText('expense-test', { exact: false }).waitFor();
    await expect(page.getByText('+¥7.25', { exact: true })).toBeVisible();
    await expect(page.getByText('-¥2.50', { exact: true })).toBeVisible();
    const ledgerDownload = page.waitForEvent('download');
    await page.getByText('导出 CSV', { exact: true }).click();
    const download = await ledgerDownload;
    assert.equal(download.suggestedFilename(), 'warehouse-ledger.csv');
    const csvFile = path.join(artifactDir, 'ledger.csv');
    await download.saveAs(csvFile);
    const csv = fs.readFileSync(csvFile, 'utf8');
    assert(csv.startsWith('\ufeff'), 'download preserves the UTF-8 BOM');
    assert.match(csv, /'\=formula-test/);
    assert.match(csv, /""quoted""/);
    assert.match(csv, /expense-test/);
    assert.match(csv, /7\.25/);

    await page.goto(base + '/pages/backup/index');
    await expect(page.locator('textarea')).toHaveCount(0);
    const backupDownload = page.waitForEvent('download');
    await page.getByText('导出备份 JSON', { exact: true }).click();
    const backup = await backupDownload;
    const backupFile = path.join(artifactDir, 'backup.json');
    await backup.saveAs(backupFile);
    const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    assert.equal(saved.data.transactions.length, 405);
    assert.equal(await page.locator('body').getAttribute('data-warehouse-print'), null, 'print mode must not leak into other pages');
    const before = db.backupData();
    async function selectBackup() {
      const choosing = page.waitForEvent('filechooser');
      await page.getByText('选择 JSON 恢复', { exact: true }).click();
      await (await choosing).setFiles(backupFile);
      await page.getByText('确认恢复', { exact: true }).waitFor();
    }
    await selectBackup();
    await page.getByText('取消', { exact: true }).click();
    assert.deepEqual(db.backupData(), before, 'cancelling restore leaves data unchanged');
    await selectBackup();
    const revision = db.revision();
    await page.getByText('继续恢复', { exact: true }).click();
    await expect.poll(() => db.revision()).toBe(revision + 1);
    assert.equal(db.listTx({}).length, 405);
    assert.equal(db.getProduct(product.id).stock, 405);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine: name, ledgerDownload: 'passed', backupDownloadAndRestore: 'passed', pageErrors: errors }));
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(artifactDir, 'failure.png') }); console.error((await page.locator('body').innerText()).slice(0, 1800)); }
    throw error;
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
