const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-workflow-repair-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  process.env.WAREHOUSE_WEB_ROOT = path.resolve('dist');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const backend = path.resolve(process.env.BOARD_BACKEND_ROOT || 'backend');
  const db = require(path.join(backend, 'db'));
  const app = require(path.join(backend, 'server'));
  const customer = db.addCustomer({ name: '客户编辑回归', contact: '原联系人', phone: '123456', address: '原地址' });
  const supplier = db.addSupplier({ name: '供应商编辑回归', contact: '原供应商联系人', phone: '123456' });
  const product = db.addProduct({ name: '草稿回归商品', specification: '40x30x20', unit: '个', stock: 100, price: 2 });
  const order = db.addOrder({ order_no: 'DRAFT-KEEP', customer_id: customer.id, specification: product.specification, quantity: 10, unit: '个', unit_price: 2, status: '生产中' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.WORKFLOW_BROWSER || 'chromium';
  const browser = await (engine === 'webkit' ? webkit : chromium).launch();
  let releaseOld;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    let holdTransactions = false, heldFinishedResolve;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin || !/^https?:$/.test(url.protocol)) return route.continue();
      if (!url.pathname.startsWith('/api/')) return route.abort();
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      if (holdTransactions && request.method() === 'GET' && url.pathname === '/api/transactions') {
        holdTransactions = false;
        await new Promise(resolve => { releaseOld = resolve; });
        await route.fulfill({ response });
        heldFinishedResolve();
        return;
      }
      return route.fulfill({ response });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const active = () => page.locator('.taro_page:visible').last();
    for (const [party, record] of [['customer', customer], ['supplier', supplier]]) {
      await page.goto(origin + '/pages/customer-edit/index?id=' + record.id + '&party=' + party);
      const name = active().locator('input').nth(0);
      await expect(name).toHaveValue(record.name);
      await active().locator('input').nth(1).fill(party + '-updated-contact');
      await active().getByText('保存', { exact: true }).click();
      await expect.poll(() => (party === 'customer' ? db.getCustomer(record.id) : db.getSupplier(record.id)).contact).toBe(party + '-updated-contact');
      assert.equal((party === 'customer' ? db.getCustomer(record.id) : db.getSupplier(record.id)).phone, '123456');
    }
    await page.goto(origin + '/pages/orders/index');
    await active().getByText('DRAFT-KEEP · 客户编辑回归', { exact: true }).waitFor();
    await active().getByText('出库', { exact: true }).click();
    await page.waitForURL(/outbound/);
    await active().getByLabel('出库数量').waitFor();
    const detailsToggle = active().locator('taro-button-core').filter({ hasText: '更多信息' });
    await detailsToggle.click();
    await expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
    const quantity = active().getByLabel('出库数量').locator('input');
    await expect(active().getByLabel('出库备注')).toBeVisible();
    const remark = active().getByLabel('出库备注').locator('input');
    await expect(quantity).toHaveValue('10');
    await quantity.fill('2'); await remark.fill('保留这份出库草稿');
    await active().getByText('刷新', { exact: true }).click();
    const submit = active().getByTestId('outbound-save');
    await expect(submit).not.toHaveAttribute('disabled', '');
    await expect(quantity).toHaveValue('2'); await expect(remark).toHaveValue('保留这份出库草稿');
    const heldFinished = new Promise(resolve => { heldFinishedResolve = resolve; });
    // Reads of the same URL share an in-flight request. Hold the transaction
    // dependency so two refreshes can observe different completed order reads.
    const ordersResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/orders' && response.request().method() === 'GET');
    const oldOrders = ordersResponse();
    holdTransactions = true;
    await active().getByText('刷新', { exact: true }).click();
    assert.equal((await (await oldOrders).json()).data.find(row => row.id === order.id).quantity, 10);
    await expect.poll(() => typeof releaseOld).toBe('function');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    db.updateOrder(order.id, { quantity: 8 });
    const newOrders = ordersResponse();
    await active().getByText('刷新', { exact: true }).click();
    assert.equal((await (await newOrders).json()).data.find(row => row.id === order.id).quantity, 8);
    await expect(submit).toHaveAttribute('disabled', '');
    releaseOld(); await heldFinished;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(active().getByText(/待发 8个/)).toBeVisible();
    await expect(quantity).toHaveValue('2'); await expect(remark).toHaveValue('保留这份出库草稿');
    db.stockOut(product.id, 99);
    await active().getByText('刷新', { exact: true }).click();
    await expect(active().getByText(/库存不足，还缺/)).toBeVisible();
    await expect(submit).toHaveAttribute('disabled', '');
    await expect(quantity).toHaveValue('2'); await expect(remark).toHaveValue('保留这份出库草稿');
    db.stockIn(product.id, 99);
    await active().getByText('刷新', { exact: true }).click();
    await expect(submit).not.toHaveAttribute('disabled', '');
    await submit.click();
    await active().getByText('送货单预览', { exact: true }).waitFor();
    assert.equal(db.getProduct(product.id).stock, 98);
    assert.equal(db.getCustomer(customer.id).debt, 4);
    const outbound = db.listTx({ type: 'out' }).find(row => row.order_id === order.id);
    assert.equal(outbound.quantity, 2); assert.equal(outbound.remark, '保留这份出库草稿');
    await page.goto(origin + '/pages/business-center/index');
    await expect(page.getByTestId('simple-workbench')).toBeVisible();
    await page.getByText('收付款', { exact: true }).locator('xpath=ancestor-or-self::taro-button-core[1]').click();
    await page.getByText('新增客户', { exact: true }).locator('xpath=ancestor-or-self::taro-button-core[1]').click();
    const companyDialog = page.getByRole('dialog', { name: '新增客户' });
    await companyDialog.getByLabel('公司名称', { exact: true }).locator('input').fill('网页尺寸本回归');
    await companyDialog.getByText('保存客户', { exact: true }).click();
    await expect(page.getByText('网页尺寸本回归', { exact: true })).toBeVisible();
    const backup = await (await fetch(origin + '/api/backup')).json();
    assert.ok(backup.data.data.customers.some(customer => customer.name === '网页尺寸本回归'));
    assert.equal(typeof backup.data.data.customer_dimensions, 'object');
    assert.deepEqual(errors, []);
    const output = path.resolve('release/workflow-repair'); fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, engine + '.png'), fullPage: true });
    console.log('PASS (' + engine + '): customer/supplier editing, orders, root/legacy links, overlapping refresh, draft preservation, insufficient stock, exact outbound commit, dimensions backup.');
  } finally {
    if (releaseOld) releaseOld();
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
