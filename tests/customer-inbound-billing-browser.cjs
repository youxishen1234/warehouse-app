const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname, '..');
  const webRoot = path.resolve(process.env.CUSTOMER_BILLING_WEB_DIR || process.env.TARO_OUTPUT_DIR || path.join(root, 'dist'));
  const evidence = path.resolve(process.env.CUSTOMER_BILLING_EVIDENCE_DIR || path.join(root, 'release/customer-inbound-billing/evidence'));
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `Missing H5 build: ${webRoot}`);
  fs.mkdirSync(evidence, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-customer-inbound-billing-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  process.env.WAREHOUSE_PRODUCT_IMAGE_DIR = path.join(temporary, 'products');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require(path.join(root, 'backend/db'));
  const spec = { id: 'carton-price', goods: '客户自产纸箱', specification: '30×20×15 cm', material: '牛皮纸', unit: '个', price: 3 };
  const customer = db.addCustomer({ name: '累计账单测试客户', specs: [spec] });
  const other = db.addCustomer({ name: '另一客户独立报价', specs: [{ ...spec, price: 5 }] });
  db.updateCustomer(customer.id, { specs: [spec] });
  db.updateCustomer(other.id, { specs: [{ ...spec, price: 5 }] });
  const dimensions = db.getCustomerDimensions();
  dimensions.customers.push({
    id: 'dimension-linked-customer',
    name: customer.name,
    specs: [
      { id: 'duplicate-quote', goods: spec.goods, size: '30×20×15', sizeUnit: 'cm', material: spec.material, unit: '个', kind: '成品' },
      { id: 'large-carton', goods: '尺寸本大包装', size: '45×30×25', sizeUnit: 'cm', material: '五层纸板', unit: '个', kind: '成品' },
      { id: 'paperboard', goods: '', size: '160×110', sizeUnit: 'cm', material: '', unit: '张', kind: '纸板' },
      { id: 'stacked-carton', goods: '堆码纸箱', size: '50×40×30', sizeUnit: 'cm', material: '加硬纸板', unit: '个', kind: '成品' }
    ]
  });
  dimensions.customers.push({
    id: 'dimension-only-customer',
    name: '尺寸本独立客户',
    specs: [
      { id: 'dimension-only-a', goods: '', size: '51×36×28', sizeUnit: 'cm', material: '', unit: '个', kind: '成品' },
      { id: 'dimension-only-b', goods: '', size: '51×29×29', sizeUnit: 'cm', material: '', unit: '个', kind: '成品' }
    ]
  });
  dimensions.customers.push({
    id: 'inactive-dimension-customer',
    name: '已停用规格客户',
    specs: [
      { id: 'inactive-dimension-spec', goods: '', size: '60×40×35', sizeUnit: 'cm', material: '', unit: '个', kind: '成品' }
    ]
  });
  db.updateCustomerDimensions(dimensions);
  const inactiveCustomer = db.addCustomer({ name: '已停用规格客户' });
  db.deleteCustomer(inactiveCustomer.id);
  const supplier = db.addSupplier({ name: '纸板测试供货商', payable: 50 });
  const carton = db.addProduct({ name: '客户自产纸箱', category: '纸箱', specification: spec.specification, material: spec.material, unit: '个', price: 9, stock: 0 });
  const requests = [];
  const app = express();
  app.use(express.json({ limit: '18mb' }));
  app.use('/api', (req, res, next) => { requests.push({ method: req.method, path: req.path, body: req.body }); next(); });
  app.use('/api', require(path.join(root, 'backend/team'))(db));
  app.use(express.static(webRoot));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {});
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(() => {
    if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
  });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device', 'access-control-expose-headers': 'X-Warehouse-Revision,Content-Disposition' };
  const pendingRoutes = new Set();
  const routeErrors = [];
  const routeErrorSummary = () => {
    const details = routeErrors.map(({ url, error }) => `${url}: ${error.stack || error}`).join('\n');
    return new Error(`Intercepted browser request failed:\n${details}`);
  };
  const waitForRoutesToSettle = async ({ throwOnError = true } = {}) => {
    let quietUntil = Date.now() + 500;
    const deadline = Date.now() + 20000;
    while (true) {
      const active = [...pendingRoutes];
      if (active.length) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timed out waiting for ${pendingRoutes.size} intercepted browser request(s) to settle`);
        let timeout;
        try {
          await Promise.race([
            Promise.allSettled(active),
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pendingRoutes.size} intercepted browser request(s) to settle`)), remaining);
            })
          ]);
        } finally {
          clearTimeout(timeout);
        }
        quietUntil = Date.now() + 500;
        continue;
      }
      if (Date.now() >= quietUntil) {
        if (throwOnError && routeErrors.length) throw routeErrorSummary();
        return;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${pendingRoutes.size} intercepted browser request(s) to settle`);
      await new Promise(resolve => setTimeout(resolve, Math.min(25, quietUntil - Date.now())));
    }
  };
  let failDimensions = false;
  await context.route('**/*', route => {
    const request = route.request();
    const requestUrl = request.url();
    const task = (async () => {
      const url = new URL(requestUrl);
      if (url.pathname.startsWith('/api/')) {
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (failDimensions && url.pathname === '/api/customer-dimensions') {
          return route.fulfill({ status: 503, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试：规格服务暂时不可用' }) });
        }
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      }
      return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    })().catch(error => {
      routeErrors.push({ url: requestUrl, error });
      return route.abort().catch(abortError => {
        routeErrors.push({ url: requestUrl, error: abortError });
      });
    });
    pendingRoutes.add(task);
    return task.finally(() => pendingRoutes.delete(task));
  });
  const input = label => page.locator(`[aria-label=${JSON.stringify(label)}] input, input[aria-label=${JSON.stringify(label)}]`).first();
  const click = label => page.locator('taro-button-core, button, [role="button"]').filter({ has: page.getByText(label, { exact: true }) }).last().click();
  const go = async route => { await page.goto('about:blank'); await page.goto(origin + '/#' + route); };
  const choose = async (label, text) => {
    const picker = page.locator(`[aria-label=${JSON.stringify(label)}]`).first();
    const matches = value => typeof text === 'string' ? value.includes(text) : text.test(value);
    if (await picker.evaluate(node => node.tagName === 'SELECT')) {
      const options = await picker.locator('option').allTextContents();
      const option = options.find(matches);
      assert.ok(option, `Missing option matching ${text} in ${label}: ${options.join(' | ')}`);
      return picker.selectOption({ label: option });
    }
    await picker.click();
    const wheel = page.locator('.weui-picker__group:visible').last();
    await expect(wheel).toBeVisible();
    await expect.poll(async () => {
      const bounds = await wheel.boundingBox();
      return Math.round(bounds.y + bounds.height);
    }).toBe(page.viewportSize().height);
    const row = wheel.locator('.weui-picker__item').filter({ hasText: text }).first();
    const box = await row.boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('.weui-picker__action:visible').filter({ hasText: '确定' }).click();
    await expect(wheel).not.toBeVisible();
    await expect(picker).toContainText(text);
  };
  const assertNoOverflow = async width => {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1)).toBe(true);
  };
  let primaryError;
  let cleanupError;
  let successMessage;
  const openCarton = async () => {
    await go('/pages/inbound/index?kind=carton');
    await expect(page.getByText('纸箱生产入库', { exact: true })).toBeVisible();
    await expect(input('货物 1 本次完工数量')).toBeVisible();
    await choose('选择客户', customer.name);
    const specPicker = page.locator('[aria-label="货物 1 客户常用规格"]').first();
    await expect(specPicker).toBeVisible();
    await choose('货物 1 客户常用规格', /客户自产纸箱 · 30×20×15 cm · 牛皮纸 · 个 ·/);
    await expect(page.getByText('选择已有商品', { exact: true })).toHaveCount(0, '选择客户后应直接选客户规格，不再经库存商品弹窗');
    assert.equal(requests.filter(row => row.method === 'POST' && row.path === '/products').length, 0, '选择客户规格不得创建库存商品');
  };
  const saveReceipt = async (number, price) => {
    await expect(input('货物 1 入库单价')).toHaveValue(String(price));
    await input('货物 1 本次完工数量').fill('100');
    await expect(page.getByTestId('inbound-total-amount')).toContainText(`¥${(price * 100).toFixed(2)}`);
    await click('更多信息');
    await input('生产工单编号').fill(number);
    const response = page.waitForResponse(row => row.request().method() === 'POST' && new URL(row.url()).pathname === '/api/delivery-notes');
    await click('确认入库');
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    const note = db.listDeliveryNotes().find(row => row.work_order_no === number);
    assert.ok(note); assert.equal(note.customer_id, customer.id); assert.equal(note.total_amount, price * 100);
    assert.equal(note.lines[0].customer_spec_id, spec.id);
    assert.equal(note.supplier_id, null);
    return note;
  };
  try {
    await openCarton();
    await expect(input('货物 1 入库单价')).toHaveValue('3');
    await choose('选择客户', other.name);
    await expect(input('货物 1 入库单价')).toHaveValue('', { timeout: 5000 });
    await choose('货物 1 客户常用规格', /客户自产纸箱 · 30×20×15 cm · 牛皮纸 · 个 ·/);
    await expect(input('货物 1 入库单价')).toHaveValue('5');
    await choose('选择客户', customer.name);
    await expect(input('货物 1 入库单价')).toHaveValue('', { timeout: 5000 });
    await choose('货物 1 客户常用规格', /客户自产纸箱 · 30×20×15 cm · 牛皮纸 · 个 ·/);
    await expect(input('货物 1 入库单价')).toHaveValue('3');
    const first = await saveReceipt('CUSTOMER-INBOUND-300', 3);
    assert.equal(db.getCustomer(customer.id).debt, 300);
    db.updateCustomer(customer.id, { specs: [{ ...spec, price: 2 }] });
    await openCarton();
    const second = await saveReceipt('CUSTOMER-INBOUND-200', 2);
    assert.equal(db.getCustomer(customer.id).debt, 500);
    assert.equal(db.getDeliveryNote(first.id).lines[0].unit_price, 3, 'saved prices are immutable snapshots');
    assert.equal(db.getProduct(carton.id).price, 9, 'customer price must not overwrite stock base price');
    assert.equal(first.lines[0].product_id, carton.id, '无歧义的历史同规格 SKU 应认领给客户，避免重复库存');
    assert.equal(second.lines[0].product_id, first.lines[0].product_id, 'repeat receipts must reuse the same customer-owned SKU');
    assert.equal(db.getProduct(carton.id).customer_id, customer.id, '认领后的历史 SKU 必须记录客户归属');
    assert.equal(db.getProduct(carton.id).stock, 200, '认领后的 SKU 应累计同一客户的两次入库');
    assert.equal(db.getCustomer(other.id).debt, 0, 'same dimensions must not combine different customers');
    // Keep actual input/amount coverage above while exercising cross-month
    // accounting with an isolated, validated historical snapshot.
    const previousMonth = new Date(); previousMonth.setDate(0);
    const priorDate = `${previousMonth.getFullYear()}-${String(previousMonth.getMonth() + 1).padStart(2, '0')}-${String(previousMonth.getDate()).padStart(2, '0')}`;
    const historical = db.backupData();
    historical.delivery_notes.find(row => row.id === first.id).date = priorDate;
    historical.ledger.find(row => row.party_type === 'supplier' && row.party_id === supplier.id).created_at = new Date(`${priorDate}T12:00:00+08:00`).getTime();
    db.restoreData(historical);

    await go('/pages/customers/index');
    await expect(page.getByTestId('customer-center')).toBeVisible();
    await expect(page.getByTestId('finance-center')).toHaveCount(0);
    const customerProfileCard = page.getByTestId(`customer-management-card-${customer.id}`);
    await expect(customerProfileCard).toBeVisible();
    const customerSpecs = page.getByTestId(`customer-specs-${customer.id}`);
    await expect(customerSpecs).toContainText('常用规格');
    await expect(customerSpecs).toContainText('客户自产纸箱');
    await expect(customerSpecs).toContainText('30×20×15 cm');
    await expect(customerSpecs).toContainText('¥2.00/个');
    await expect(customerSpecs.locator('[data-testid^="customer-spec-"]')).toHaveCount(3);
    await expect(customerSpecs).toContainText('160×110 cm');
    await expect(customerSpecs).toContainText('纸板');
    await expect(customerSpecs).toContainText('价格未记录');
    await expect(customerSpecs).not.toContainText('50×40×30 cm', { timeout: 1000 });
    await page.getByTestId(`customer-specs-toggle-${customer.id}`).click();
    await expect(customerSpecs.locator('[data-testid^="customer-spec-"]')).toHaveCount(4);
    await expect(customerSpecs).toContainText('50×40×30 cm');
    await page.getByTestId(`customer-specs-toggle-${customer.id}`).click();
    await expect(customerSpecs).not.toContainText('50×40×30 cm', { timeout: 1000 });
    const dimensionOnlyCard = page.getByTestId('customer-specs-only-dimension:1');
    await expect(dimensionOnlyCard).toContainText('尺寸本独立客户');
    await expect(dimensionOnlyCard).toContainText('51×36×28 cm');
    await expect(dimensionOnlyCard).toContainText('待建立客户资料');
    await expect(page.getByTestId('customer-create-from-dimension-dimension:1')).toBeVisible();
    await expect(page.getByText('已停用规格客户', { exact: true })).toHaveCount(0);
    const accountsBeforeDimensionConversion = db.listCustomers().length;
    await page.getByTestId('customer-create-from-dimension-dimension:1').click();
    const dimensionEditor = page.getByTestId('customer-editor');
    await expect(dimensionEditor).toBeVisible();
    await expect(dimensionEditor.getByLabel('公司名称').locator('input')).toHaveValue('尺寸本独立客户');
    await dimensionEditor.getByText('取消', { exact: true }).click();
    await expect(dimensionEditor).toHaveCount(0);
    assert.equal(db.listCustomers().length, accountsBeforeDimensionConversion, 'canceling account setup must not create a customer');
    await dimensionOnlyCard.screenshot({ path: path.join(evidence, 'customer-specs-only-390.png') });
    const partySearch = page.getByTestId('customer-center-search').locator('input');
    await partySearch.fill('45x30x25');
    await expect(customerProfileCard).toBeVisible();
    await expect(dimensionOnlyCard).toHaveCount(0);
    await partySearch.fill('');
    failDimensions = true;
    const failedDimensions = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/customer-dimensions' && response.status() === 503
    );
    await page.getByLabel('刷新服务器数据').click();
    await failedDimensions;
    await expect(customerProfileCard).toBeVisible();
    await expect(dimensionOnlyCard).toHaveCount(0);
    failDimensions = false;
    const restoredDimensions = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/customer-dimensions' && response.status() === 200
    );
    await page.getByLabel('刷新服务器数据').click();
    await restoredDimensions;
    await expect(dimensionOnlyCard).toBeVisible();
    await expect(page.getByText(/测试.*规格服务/)).toBeHidden({ timeout: 5000 });

    await page.getByTestId('customer-create-from-dimension-dimension:1').click();
    const conversionEditor = page.getByTestId('customer-editor');
    await expect(conversionEditor.getByLabel('公司名称').locator('input')).toHaveValue('尺寸本独立客户');
    await conversionEditor.getByText('保存客户', { exact: true }).click();
    await expect(conversionEditor).toHaveCount(0);
    let convertedCustomer;
    await expect.poll(() => {
      convertedCustomer = db.listCustomers().find(row => row.name === '尺寸本独立客户');
      return convertedCustomer?.id;
    }).toBeTruthy();
    await expect(page.getByTestId('customer-specs-only-dimension:1')).toHaveCount(0);
    const convertedProfileCard = page.getByTestId(`customer-management-card-${convertedCustomer.id}`);
    await expect(convertedProfileCard).toContainText('51×36×28 cm');
    await expect(convertedProfileCard).toContainText('价格未记录');

    await page.getByTestId(`customer-view-bills-${customer.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/pages/business-center/index\\?section=finance&view=customer&party_type=customer&party_id=${customer.id}`));
    await expect(page.getByTestId('customer-center')).toHaveCount(0);
    await expect(page.getByTestId('finance-center')).toBeVisible();
    const customerCard = page.getByTestId(`customer-bill-${customer.id}`);
    await expect(customerCard).toContainText('500.00');
    const partySummary = page.getByTestId('finance-party-summary');
    await expect(partySummary).toContainText('500.00');
    const financeSearch = page.getByTestId('finance-party-search').locator('input');
    await financeSearch.fill('45x30x25');
    await expect(customerCard).toBeVisible();
    await expect(partySummary).toContainText('500.00');
    await financeSearch.fill('');
    await page.getByTestId(`customer-bill-details-${customer.id}`).click();
    await expect(page.getByTestId(`production-inbound-${first.id}`)).toContainText('300.00');
    await expect(page.getByTestId(`production-inbound-${second.id}`)).toContainText('200.00');
    await page.getByRole('button', { name: '本月', exact: true }).click();
    await expect(customerCard).toContainText('本月自产入库金额');
    await expect(customerCard).toContainText('200.00');
    await expect(page.getByTestId(`production-inbound-${first.id}`)).toHaveCount(0);
    await page.getByRole('button', { name: '全部时间', exact: true }).click();
    await expect(page.getByTestId(`production-inbound-${first.id}`)).toContainText('300.00');
    for (const width of [320, 390, 1280]) {
      await assertNoOverflow(width);
      await customerCard.screenshot({ path: path.join(evidence, `customer-bill-500-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 900 });

    // Exact receipt and settlement UI assertions are deliberately separate from
    // server checks: neither side may manufacture a second running balance.
    await page.getByTestId(`finance-settle-customer-${customer.id}`).click();
    await input('客户收款金额').fill('100');
    await click('确认收款');
    await expect.poll(() => db.getCustomer(customer.id).debt).toBe(400);
    await expect(customerCard).toContainText('400.00');
    await expect(customerCard).toContainText('500.00');
    const shipped = db.stockOut(first.lines[0].product_id, 200, 'E2E', '已入库计账纸箱发货', customer.id, { unit_price: 2, specification: spec.specification });
    assert.equal(shipped.transaction.receivable_amount, 0);
    assert.equal(db.getCustomer(customer.id).debt, 400, 'shipping the billed cartons must not charge again');
    await page.getByLabel('刷新服务器数据').click();
    await expect(customerCard).toContainText('400.00');
    if (!(await page.getByTestId(`production-inbound-${first.id}`).count())) await page.getByTestId(`customer-bill-details-${customer.id}`).click();
    await expect(page.getByTestId(`production-inbound-${first.id}`)).toContainText('300.00');
    await page.screenshot({ path: path.join(evidence, 'customer-bill-paid100.png'), fullPage: true });
    await page.getByTestId('finance-tab-ledger').click();
    for (const row of db.listLedger().filter(entry => entry.party_id === customer.id && entry.party_type === 'customer')) {
      await expect(page.getByTestId(`ledger-entry-${row.id}`)).toBeVisible();
    }
    await page.getByTestId('finance-tab-supplier').click();
    const supplierCard = page.getByTestId(`supplier-bill-${supplier.id}`);
    await expect(supplierCard).toContainText('50.00');
    await page.getByRole('button', { name: `查看供货商账单明细 ${supplier.name}`, exact: true }).click();
    await expect(supplierCard).toContainText('期初');
    await page.getByRole('button', { name: '本月', exact: true }).click();
    await expect(supplierCard).toContainText('本月已付');
    await expect(supplierCard).not.toContainText('期初');
    await expect(supplierCard).toContainText('50.00');
    await page.getByRole('button', { name: '上月', exact: true }).click();
    await expect(supplierCard).toContainText('期初');
    await page.getByRole('button', { name: '全部时间', exact: true }).click();
    await assertNoOverflow(320); await assertNoOverflow(1440);
    await page.screenshot({ path: path.join(evidence, 'finance-three-views.png'), fullPage: true });
    await go(`/pages/ledger/index?party_type=customer&party_id=${customer.id}`);
    await expect(page.getByTestId('finance-center')).toBeVisible();
    await expect(page).toHaveURL(/pages\/business-center\/index/);
    assert.doesNotThrow(() => db.validateBackup(db.backupData()));
    assert.deepEqual(errors, []);
    assert.equal(requests.filter(row => row.method === 'POST' && row.path === '/delivery-notes').length, 2);
    successMessage = `PASS: customer specs from quotes and dimensions, account conversion, inbound 300+200=500, price snapshots, settlement 100 leaves400, no double billing, unified finance tabs, legacy route and responsive layouts. Evidence: ${evidence}`;
  } catch (error) {
    primaryError = error;
    await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure-text.txt'), await page.locator('body').innerText().catch(() => ''));
    fs.writeFileSync(path.join(evidence, 'failure.html'), await page.content().catch(() => ''));
  } finally {
    try {
      // Keep interception installed until every in-flight route.fetch has
      // fulfilled. unrouteAll during an async route callback can auto-handle
      // that request, leaving the callback to reject on its later fulfill.
      await waitForRoutesToSettle({ throwOnError: !primaryError });
    } catch (error) {
      cleanupError = error;
    }
    try { await context.unrouteAll({ behavior: 'wait' }); } catch (error) { cleanupError ||= error; }
    try { await context.close(); } catch (error) { cleanupError ||= error; }
    try { await browser.close(); } catch (error) { cleanupError ||= error; }
    server.closeAllConnections();
    try { await new Promise(resolve => server.close(resolve)); } catch (error) { cleanupError ||= error; }
    if (!primaryError && routeErrors.length) cleanupError ||= routeErrorSummary();
    if (!primaryError && errors.length) cleanupError ||= new Error(`Browser page error(s): ${errors.join('; ')}`);
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  console.log(successMessage);
}

main().catch(error => {
  console.error(error);
  if (process.env.GITHUB_ACTIONS === 'true') {
    const detail = String(error?.stack || error).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error(`::error file=tests/customer-inbound-billing-browser.cjs,title=Customer billing browser acceptance::${detail}`);
  }
  process.exitCode = 1;
});
