const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-print-sync-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.PRINT_WEB_DIR || 'release/print-center-01a1211e/web');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], ledger: []
  }));

  const db = require('../backend/db');
  const product = db.addProduct({
    name: '同步验收纸箱',
    specification: '460×300×200',
    unit: '个',
    stock: 100,
    price: 1
  });
  const customer = db.addCustomer({
    name: '同步验收客户',
    contact: '王师傅',
    phone: '13800138046',
    address: '同步测试地址 46 号'
  });
  db.updateCustomer(customer.id, {
    specs: [{ id: 'sync-spec', goods: product.name, specification: '460x300x200', material: '五层', unit: '个', price: 1 }]
  });
  assert.equal(db.listCustomers({ keyword: customer.name }).length, 1, 'seeded customer must be searchable');

  const app = process.env.PRINT_SOURCE_PREVIEW === '1'
    ? require('./helpers/print-center-source.cjs')(db)
    : require('../backend/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const engine = process.env.PRINT_BROWSER || 'chromium';
  const browser = await (engine === 'webkit' ? webkit : chromium).launch(engine === 'webkit' || !process.env.PRINT_BROWSER_EXECUTABLE ? {} : { executablePath: process.env.PRINT_BROWSER_EXECUTABLE });
  const artifacts = path.resolve(process.env.PRINT_ARTIFACTS || 'release/print-center-sync-' + Date.now(), engine);
  fs.mkdirSync(artifacts, { recursive: true });

  const errors = [];
  const writes = [];
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    context.on('request', request => {
      const url = new URL(request.url());
      if (request.method() !== 'GET' && url.pathname.startsWith('/api/')) {
        writes.push({ method: request.method(), path: url.pathname, body: request.postData() || '' });
      }
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin || !/^https?:$/.test(url.protocol)) return route.continue();
      if (!url.pathname.startsWith('/api/')) return route.abort();
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      return route.fulfill({ response });
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));

    const button = name => page.getByRole('button', { name, exact: true });
    const preview = () => page.getByRole('dialog', { name: '送货单预览' });
    const snapshot = () => ({
      stock: db.getProduct(product.id).stock,
      debt: db.getCustomer(customer.id).debt,
      transactions: db.listTx().length,
      receivables: db.listLedger({ type: 'receivable' }).length,
      notes: db.listPrintNotes().length
    });

    await page.goto(origin + '/#/pages/print-center/index');
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await button('新建送货单').click();
    await button('搜索客户').click();
    const customerResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/customers' && url.searchParams.has('keyword');
    });
    await page.getByLabel('搜索客户名称或电话').fill(customer.name);
    const customerResponse = await customerResponsePromise;
    const customerPayload = await customerResponse.json();
    assert.equal(customerResponse.status(), 200, JSON.stringify(customerPayload));
    assert.equal(customerPayload.data?.length, 1, customerResponse.url() + ' ' + JSON.stringify(customerPayload));
    await page.getByRole('button', { name: new RegExp(customer.name) }).click();
    await page.getByLabel('选择客户常用规格').selectOption('sync-spec');
    await expect(page.getByLabel('第1项产品名称')).toHaveValue(product.name);
    await expect(page.getByLabel('第1项规格尺寸')).toHaveValue(product.specification);
    await page.getByLabel('第1项数量').fill('46');
    await page.getByLabel('送货人', { exact: true }).fill('同步测试送货员');

    const primary = button('确认出库并打印');
    await expect(primary).toBeEnabled();
    await primary.evaluate(element => { element.click(); element.click(); });
    await expect.poll(() => db.listPrintNotes().length).toBe(1);
    await expect(preview()).toBeVisible();
    await expect.poll(() => db.getProduct(product.id).stock).toBe(54);
    await expect.poll(() => db.getCustomer(customer.id).debt).toBe(46);

    let note = db.listPrintNotes()[0];
    const outbound = db.listTx().filter(row => row.type === 'out');
    const receivables = db.listLedger({ type: 'receivable' });
    assert.ok(note.outbound_at, 'the primary action must persist the outbound state');
    assert.equal(note.items[0].quantity, 46);
    assert.equal(outbound.length, 1, 'the 46-unit delivery creates one outbound transaction');
    assert.equal(outbound[0].quantity, 46);
    assert.equal(receivables.length, 1, 'the 46-unit delivery creates one receivable');
    assert.equal(receivables[0].amount, 46);
    assert.deepEqual(note.transaction_ids, [outbound[0].id]);

    const afterShipment = snapshot();
    await page.evaluate(() => { window.__printCalls = 0; window.print = () => window.__printCalls++; });
    await expect(button('打印送货单')).toBeEnabled();
    await button('打印送货单').click();
    assert.equal(await page.evaluate(() => window.__printCalls), 1);
    await button('返回单据').click();
    assert.deepEqual(snapshot(), afterShipment, 'physical printing must not roll back or repeat shipment');

    await button('再次打印').click();
    await expect(preview()).toBeVisible();
    await button('返回单据').click();
    await button('历史单据').click();
    await button('重新打印').click();
    await expect(preview()).toBeVisible();
    assert.deepEqual(snapshot(), afterShipment, 'reprints do not deduct stock or add receivables');
    await button('返回单据').click();

    const sourceWrites = writes.length;
    const sourceSnapshot = snapshot();
    await page.goto(origin + '/#/pages/print-center/index?transaction_id=' + outbound[0].id);
    await page.reload();
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await expect(page.locator('[data-source-status="ready"]')).toBeVisible();
    await expect(page.locator('main fieldset')).toHaveAttribute('disabled', '');
    await expect(button('保存单据')).toHaveCount(0);
    await expect(button('确认出库并打印')).toHaveCount(0);
    await button('预览打印').click();
    await expect(preview()).toBeVisible();
    await expect(button('打印送货单')).toBeEnabled();
    assert.equal(writes.length, sourceWrites, 'posted transaction preview must stay read-only');
    await page.evaluate(() => { window.__printCalls = 0; window.print = () => window.__printCalls++; });
    await button('打印送货单').click();
    assert.equal(await page.evaluate(() => window.__printCalls), 1);
    await button('返回单据').click();
    await button('预览打印').click();
    await expect(preview()).toBeVisible();
    await button('返回单据').click();
    assert.deepEqual(snapshot(), sourceSnapshot, 'posted transaction preview never ships, saves, or reprints the stock transaction');
    assert.equal(writes.length, sourceWrites, 'opening and printing the posted transaction creates no print-note writes');

    await page.goto(origin + '/#/pages/print-center/index?transaction_id=999999');
    await page.reload();
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await expect(page.getByRole('alert')).toContainText('原单据不存在');
    await expect(page.locator('main fieldset')).toHaveAttribute('disabled', '');
    await expect(button('预览打印')).toBeDisabled();
    await expect(button('确认出库并打印')).toHaveCount(0);
    assert.deepEqual(snapshot(), sourceSnapshot, 'invalid source links never become writable notes');
    assert.deepEqual(errors, []);

    const result = {
      engine,
      items: 46,
      stock: { before: 100, after: sourceSnapshot.stock },
      debt: sourceSnapshot.debt,
      transactions: sourceSnapshot.transactions,
      receivables: sourceSnapshot.receivables,
      duplicateClicks: 'single shipment',
      postedSourceWrites: writes.length - sourceWrites,
      screenshots: artifacts
    };
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
      console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 4000));
    }
    throw error;
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
