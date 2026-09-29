const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium, webkit, expect } = require('@playwright/test');

async function main() {
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-party-backups-'));
  process.env.WAREHOUSE_BACKUP_DIR = backups;
  process.env.TEAM_PREVIEW_PORT = '0';
  const { server, db } = await require('../scripts/team-preview.cjs')();
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const supplier = db.addSupplier({ name: 'Supplier before' });
    const customer = db.addCustomer({ name: 'Customer before' });
    const product = db.addProduct({ name: 'Snapshot product', stock: 10, price: 2, unit: 'unit' });
    db.stockIn(product.id, 1, '', '', supplier.id);
    db.stockOut(product.id, 1, '', '', customer.id);
    const transactions = db.backupData().transactions;
    db.updateSupplier(supplier.id, { name: 'Supplier after' });
    db.updateCustomer(customer.id, { name: 'Customer after' });
    db.deleteSupplier(supplier.id);
    db.deleteCustomer(customer.id);
    for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors = [];
        let failRecords = true;
        let failedRecordRequests = 0;
        let successfulRecordRequests = 0;
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin === origin) return route.continue();
          if (['http://152.136.100.200', 'https://youxishen.online'].includes(url.origin) && url.pathname.startsWith('/api/')) {
            if (url.pathname === '/api/transactions' && failRecords) {
              failedRecordRequests++;
              return route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ success: false, message: 'Temporary test failure' }) });
            }
            if (url.pathname === '/api/transactions') successfulRecordRequests++;
            const response = await route.fetch({ url: origin + url.pathname + url.search });
            return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
          }
          return route.abort();
        });
        await page.goto(origin + '/pages/records/index');
        const retry = page.getByText('记录加载失败，请点击重试', { exact: true });
        await expect(retry).toBeVisible();
        assert.ok(failedRecordRequests > 0, 'the real transaction request reached the failure fixture');
        await expect(page.getByText('暂无记录', { exact: true })).toHaveCount(0);
        const requestsBeforeRetry = failedRecordRequests;
        // Rapid repeated user reloads must never resolve to fabricated empty
        // records. The initial API revision also triggers a shared refresh.
        await retry.evaluate(element => { element.click(); element.click(); });
        await expect(retry).toBeVisible();
        await expect.poll(() => failedRecordRequests).toBeGreaterThan(requestsBeforeRetry);
        await expect(page.getByText('暂无记录', { exact: true })).toHaveCount(0);
        failRecords = false;
        await retry.click();
        await expect(page.getByText('Supplier before（现名：Supplier after）', { exact: true })).toBeVisible();
        await expect(page.getByText('Customer before（现名：Customer after）', { exact: true })).toBeVisible();
        assert.ok(successfulRecordRequests > 0, 'retry fetched actual backend records');
        assert.deepEqual(db.backupData().transactions, transactions, 'viewing and renaming cannot mutate snapshots');
        assert.deepEqual(errors, []);
        await expect(retry).toHaveCount(0);
        await expect(page.getByText('正在加载记录…', { exact: true })).toHaveCount(0);
        console.log(`${name}: failed record load, click retry, real API historical/current party names passed`);
      } finally { await browser.close(); }
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(backups, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
