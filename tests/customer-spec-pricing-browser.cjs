const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname, '..');
  const webRoot = path.resolve(process.env.CUSTOMER_SPEC_PRICING_WEB_DIR || path.join(root, 'dist'));
  const evidence = path.resolve(process.env.CUSTOMER_SPEC_PRICING_EVIDENCE_DIR || path.join(root, 'release/customer-spec-pricing-review/evidence'));
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `Missing H5 build: ${webRoot}`);
  fs.mkdirSync(evidence, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-customer-spec-pricing-browser-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  process.env.WAREHOUSE_PRODUCT_IMAGE_DIR = path.join(temporary, 'products');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require(path.join(root, 'backend/db'));
  const baseQuote = {
    id: 'carton-price', goods: '客户自产纸箱', specification: '30×20×15 cm',
    material: '牛皮纸', unit: '个', price: 3, kind: '成品'
  };
  const paperboardQuote = {
    id: 'paperboard-price', goods: '客户采购纸板', specification: '160×110 cm',
    material: '五层纸板', unit: '张', price: 2, kind: '纸板'
  };
  const customer = db.addCustomer({ name: '规格定价验收客户' });
  db.updateCustomer(customer.id, { specs: [baseQuote, paperboardQuote] });
  const dimensions = db.getCustomerDimensions();
  dimensions.customers.push({
    id: 'dimension-linked-customer', name: customer.name,
    specs: [
      { id: 'duplicate-quote', goods: baseQuote.goods, size: '30×20×15', sizeUnit: 'cm', material: baseQuote.material, unit: '个', kind: '成品' },
      { id: 'large-carton', goods: '尺寸本大包装', size: '45×30×25', sizeUnit: 'cm', material: '五层纸板', unit: '个', kind: '成品' }
    ]
  });
  db.updateCustomerDimensions(dimensions);
  const dimensionsBeforeConversion = JSON.stringify(db.getCustomerDimensions());
  const requests = [];
  let malformedQuoteWrite = false;
  let failReceiptRecovery = false;
  const app = express();
  app.use(express.json({ limit: '18mb' }));
  app.use('/api', (req, res, next) => {
    requests.push({ method: req.method, path: req.path, body: req.body });
    next();
  });
  app.use('/api', require(path.join(root, 'backend/team'))(db));
  app.use(express.static(webRoot));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(() => {
    if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
  });
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device',
    'access-control-expose-headers': 'X-Warehouse-Revision,Content-Disposition'
  };
  const pendingRoutes = new Set();
  await context.route('**/*', route => {
    const request = route.request();
    const requestUrl = request.url();
    const task = (async () => {
      const url = new URL(requestUrl);
      if (!url.pathname.startsWith('/api/')) {
        return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
      }
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (failReceiptRecovery && request.method() === 'GET' && url.pathname.startsWith('/api/sync/receipt/')) {
        failReceiptRecovery = false;
        return route.fulfill({ status: 503, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试：回执暂时不可用' }) });
      }
      if (malformedQuoteWrite && request.method() === 'PUT' && url.pathname === `/api/customers/${customer.id}`) {
        malformedQuoteWrite = false;
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        failReceiptRecovery = true;
        return route.fulfill({ status: 200, headers: { ...response.headers(), ...cors }, contentType: 'application/json', body: '{"success":true,' });
      }
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    })().catch(async error => {
      await route.abort().catch(() => {});
      throw error;
    });
    pendingRoutes.add(task);
    return task.finally(() => pendingRoutes.delete(task));
  });
  const input = label => page.locator(`[aria-label=${JSON.stringify(label)}] input, input[aria-label=${JSON.stringify(label)}]`).first();
  const dialog = page.getByTestId('customer-quote-editor');
  const click = async label => page.locator('taro-button-core, button, [role="button"]').filter({ hasText: label }).last().click();
  const go = async route => { await page.goto('about:blank'); await page.goto(origin + '/#' + route); };
  const customerSpecs = page.getByTestId(`customer-specs-${customer.id}`);
  const openCustomerCenter = async () => {
    await go('/pages/customers/index');
    await expect(page.getByTestId('customer-center')).toBeVisible();
    await expect(page.getByTestId(`customer-management-card-${customer.id}`)).toBeVisible();
  };
  const ensureSpecsExpanded = async () => {
    const toggle = page.getByTestId(`customer-specs-toggle-${customer.id}`);
    if (await toggle.count() && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  };
  const openAdd = async () => {
    await page.getByTestId(`customer-spec-add-${customer.id}`).click();
    await expect(dialog).toBeVisible();
  };
  const fillRequired = async ({ goods, size, material = '', unit, price }) => {
    await input('规格货物').fill(goods);
    await input('规格尺寸').fill(size);
    if (material) await input('规格材质').fill(material);
    await input('规格单位').fill(unit);
    await input('规格常用单价').fill(price);
  };
  const saveDialog = async () => {
    await page.getByTestId('customer-quote-save').click();
    await expect(dialog).toHaveCount(0);
  };
  const quotePutCount = () => requests.filter(row => row.method === 'PUT' && row.path === `/customers/${customer.id}`).length;
  const choose = async (label, text) => {
    const picker = page.locator(`[aria-label=${JSON.stringify(label)}]`).first();
    if (await picker.evaluate(node => node.tagName === 'SELECT')) return picker.selectOption({ label: text });
    await picker.click();
    const wheel = page.locator('.weui-picker__group:visible').last();
    await expect(wheel).toBeVisible();
    await expect.poll(async () => {
      const bounds = await wheel.boundingBox();
      return bounds ? Math.round(bounds.y + bounds.height) : -1;
    }).toBe(page.viewportSize().height);
    const row = wheel.locator('.weui-picker__item').filter({ hasText: text }).first();
    const box = await row.boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('.weui-picker__action:visible').filter({ hasText: '确定' }).click();
    await expect(wheel).not.toBeVisible();
    await expect(picker).toContainText(text);
  };
  const assertDialogFits = async width => {
    await page.setViewportSize({ width, height: 700 });
    await expect.poll(() => page.evaluate(() => {
      const node = document.querySelector('[data-testid="customer-quote-editor"]');
      if (!node) return false;
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth + 1 && node.scrollWidth <= node.clientWidth + 1
        && document.documentElement.scrollWidth <= innerWidth + 1;
    })).toBe(true);
  };
  let primaryError;
  let cleanupError;
  try {
    await openCustomerCenter();
    await expect(customerSpecs).toContainText(baseQuote.goods);
    await expect(customerSpecs).toContainText('¥3.00/个');
    await expect(customerSpecs).toContainText(paperboardQuote.goods);

    await openAdd();
    await assertDialogFits(320);
    await dialog.screenshot({ path: path.join(evidence, 'customer-quote-add-320.png') });
    await assertDialogFits(390);
    await dialog.screenshot({ path: path.join(evidence, 'customer-quote-add-390.png') });
    await fillRequired({ goods: '取消后不保存', size: '50×40×30', unit: '个', price: '1' });
    await dialog.getByText('取消', { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(db.getCustomer(customer.id).specs.some(spec => spec.goods === '取消后不保存'), false);

    await openAdd();
    await fillRequired({ goods: '零价纸箱', size: '50×40×30', material: '三层纸板', unit: '个', price: '' });
    await page.getByTestId('customer-quote-save').click();
    await expect(dialog.getByRole('alert')).toContainText('常用单价必填');
    await expect(dialog).toBeVisible();
    await input('规格常用单价').fill('0');
    await saveDialog();
    await expect.poll(() => db.getCustomer(customer.id).specs.find(spec => spec.goods === '零价纸箱')?.price).toBe(0);
    await ensureSpecsExpanded();
    await expect(customerSpecs).toContainText('零价纸箱');
    await expect(customerSpecs).toContainText('¥0.00/个');

    await openAdd();
    await fillRequired({ goods: '超高精度纸箱', size: '60×50×40', material: '五层牛卡', unit: '个', price: '0.123456789' });
    await saveDialog();
    await expect.poll(() => db.getCustomer(customer.id).specs.find(spec => spec.goods === '超高精度纸箱')?.price).toBe(0.123456789);
    await ensureSpecsExpanded();
    await expect(customerSpecs).toContainText('¥0.123456789/个');

    const preciseSpec = db.getCustomer(customer.id).specs.find(spec => spec.goods === '超高精度纸箱');
    await page.getByTestId(`customer-spec-edit-quote:${customer.id}:${preciseSpec.id}`).click();
    await expect(dialog).toBeVisible();
    await input('规格常用单价').fill('1.123456789');
    await saveDialog();
    await expect.poll(() => db.getCustomer(customer.id).specs.find(spec => spec.id === preciseSpec.id)?.price).toBe(1.123456789);
    await ensureSpecsExpanded();
    await expect(customerSpecs).toContainText('¥1.123456789/个');

    await page.getByTestId(`customer-spec-edit-quote:${customer.id}:carton-price`).click();
    await expect(dialog).toBeVisible();
    await input('规格常用单价').fill('6.25');
    const concurrentQuote = {
      id: 'concurrent-other', goods: '另一端新增规格', specification: '70×60×50 cm',
      material: '七层', unit: '个', price: 5.5, kind: '成品'
    };
    db.updateCustomer(customer.id, { specs: [...db.getCustomer(customer.id).specs, concurrentQuote] });
    await saveDialog();
    await expect.poll(() => db.getCustomer(customer.id).specs.find(spec => spec.id === 'carton-price')?.price).toBe(6.25);
    assert.deepEqual(db.getCustomer(customer.id).specs.find(spec => spec.id === concurrentQuote.id), concurrentQuote);
    await ensureSpecsExpanded();
    await expect(customerSpecs).toContainText(concurrentQuote.goods);

    await page.getByTestId(`customer-spec-edit-quote:${customer.id}:carton-price`).click();
    await input('规格常用单价').fill('9.75');
    db.updateCustomer(customer.id, {
      specs: db.getCustomer(customer.id).specs.map(spec => spec.id === 'carton-price' ? { ...spec, price: 7.25 } : spec)
    });
    await page.getByTestId('customer-quote-save').click();
    await expect(dialog.getByRole('alert')).toContainText('此规格已被另一端修改');
    await expect(input('规格常用单价')).toHaveValue('9.75');
    assert.equal(db.getCustomer(customer.id).specs.find(spec => spec.id === 'carton-price').price, 7.25);
    await dialog.getByLabel('关闭规格编辑').click();
    await expect(dialog).toHaveCount(0);

    await openCustomerCenter();
    await ensureSpecsExpanded();
    await expect(customerSpecs).toContainText('¥7.25/个');

    await page.getByTestId(`customer-spec-edit-quote:${customer.id}:carton-price`).click();
    await input('规格常用单价').fill('8.5');
    const putsBeforeUnconfirmed = quotePutCount();
    malformedQuoteWrite = true;
    await page.getByTestId('customer-quote-save').click();
    await expect(dialog.getByRole('alert')).toContainText(/未确认|表单已保留/);
    await expect(dialog).toBeVisible();
    assert.equal(db.getCustomer(customer.id).specs.find(spec => spec.id === 'carton-price').price, 8.5);
    assert.equal(quotePutCount(), putsBeforeUnconfirmed + 1);
    await page.getByTestId('customer-quote-save').click();
    await expect(dialog).toHaveCount(0);
    assert.equal(quotePutCount(), putsBeforeUnconfirmed + 1, 'retrying the confirmed write must not PUT twice');

    await ensureSpecsExpanded();
    await page.getByTestId('customer-spec-edit-dimension:dimension-linked-customer:large-carton').click();
    await expect(dialog).toBeVisible();
    await expect(input('规格常用单价')).toHaveValue('');
    await input('规格常用单价').fill('2.75');
    await saveDialog();
    const converted = db.getCustomer(customer.id).specs.find(spec => spec.goods === '尺寸本大包装');
    assert.equal(converted.price, 2.75);
    assert.deepEqual(converted.dimension_source, { customer_id: 'dimension-linked-customer', spec_id: 'large-carton' });
    assert.equal(JSON.stringify(db.getCustomerDimensions()), dimensionsBeforeConversion, 'converting a dimension book spec must not rewrite its source document');
    await ensureSpecsExpanded();
    await expect(customerSpecs).toContainText('尺寸本大包装');
    await expect(page.getByTestId('customer-spec-edit-dimension:dimension-linked-customer:large-carton')).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 900 });
    await customerSpecs.screenshot({ path: path.join(evidence, 'customer-spec-pricing-390.png') });
    const viewerSession = { token: 'viewer-ui-fixture', user: { id: 'viewer-ui', username: 'viewer', role: 'viewer', disabled: false } };
    await page.evaluate(session => localStorage.setItem('warehouse_session_v1', JSON.stringify({ data: session })), viewerSession);
    await openCustomerCenter();
    await expect(page.getByTestId(`customer-spec-add-${customer.id}`)).toHaveCount(0);
    await expect(customerSpecs.getByText('编辑', { exact: true })).toHaveCount(0);
    assert.deepEqual(errors, []);
  } catch (error) {
    primaryError = error;
    await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure-text.txt'), await page.locator('body').innerText().catch(() => ''));
  } finally {
    try {
      const settled = await Promise.allSettled([...pendingRoutes]);
      const rejected = settled.find(result => result.status === 'rejected');
      if (!primaryError && rejected) cleanupError = rejected.reason;
    } catch (error) { cleanupError = error; }
    try { await context.unrouteAll({ behavior: 'wait' }); } catch (error) { cleanupError ||= error; }
    try { await context.close(); } catch (error) { cleanupError ||= error; }
    try { await browser.close(); } catch (error) { cleanupError ||= error; }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (!primaryError && errors.length) cleanupError ||= new Error(`Browser page error(s): ${errors.join('; ')}`);
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  console.log(`PASS: customer spec add/edit pricing, zero and full precision, dimension conversion, concurrent merge/conflict, unconfirmed retry, latest inbound price, viewer read-only, responsive dialog. Evidence: ${evidence}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
