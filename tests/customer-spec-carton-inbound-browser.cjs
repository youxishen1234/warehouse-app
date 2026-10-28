const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname, '..');
  const webRoot = path.resolve(process.env.CUSTOMER_SPEC_INBOUND_WEB_DIR || process.env.TARO_OUTPUT_DIR || path.join(root, 'dist'));
  const evidence = path.resolve(process.env.CUSTOMER_SPEC_INBOUND_EVIDENCE_DIR || path.join(root, 'release/customer-spec-carton-inbound-20261027/evidence'));
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `Missing H5 build: ${webRoot}`);
  fs.mkdirSync(evidence, { recursive: true });

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-customer-spec-carton-inbound-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  process.env.WAREHOUSE_PRODUCT_IMAGE_DIR = path.join(temporary, 'products');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));

  const dbPath = path.join(root, 'backend/db');
  delete require.cache[require.resolve(dbPath)];
  const db = require(dbPath);
  const apiRequests = [];
  const app = express();
  app.use(express.json({ limit: '18mb' }));
  app.use('/api', (req, res, next) => { apiRequests.push({ method: req.method, path: req.path, body: req.body }); next(); });
  app.use('/api', require(path.join(root, 'backend/team'))(db));
  app.use(express.static(webRoot));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {});
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  const externalBlocked = [];
  const routeErrors = [];
  const pendingRoutes = new Set();
  let failCartonCustomerRead = false;
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.addInitScript(() => {
    if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
  });

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device',
    'access-control-expose-headers': 'X-Warehouse-Revision,Content-Disposition'
  };
  const routeErrorSummary = () => new Error(`Intercepted browser request failed:\n${routeErrors.map(({ url, error }) => `${url}: ${error.stack || error}`).join('\n')}`);
  const waitForRoutesToSettle = async ({ throwOnError = true } = {}) => {
    let quietUntil = Date.now() + 500;
    const deadline = Date.now() + 20000;
    while (true) {
      const active = [...pendingRoutes];
      if (active.length) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timed out waiting for ${pendingRoutes.size} intercepted browser request(s)`);
        let timeout;
        try {
          await Promise.race([
            Promise.allSettled(active),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pendingRoutes.size} intercepted browser request(s)`)), remaining); })
          ]);
        } finally { clearTimeout(timeout); }
        quietUntil = Date.now() + 500;
        continue;
      }
      if (Date.now() >= quietUntil) { if (throwOnError && routeErrors.length) throw routeErrorSummary(); return; }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for intercepted browser requests to settle');
      await new Promise(resolve => setTimeout(resolve, Math.min(25, quietUntil - Date.now())));
    }
  };

  await context.route('**/*', route => {
    const request = route.request();
    const requestUrl = request.url();
    const task = (async () => {
      const url = new URL(requestUrl);
      if (/^https?:$/.test(url.protocol) && url.pathname.startsWith('/api/')) {
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (failCartonCustomerRead && request.method() === 'GET' && url.pathname === '/api/production-inbound/customers') {
          return route.fulfill({ status: 503, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试：入库客户资料暂时不可用' }) });
        }
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      }
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      if (/^https?:$/.test(url.protocol)) externalBlocked.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    })().catch(error => {
      routeErrors.push({ url: requestUrl, error });
      return route.abort().catch(abortError => routeErrors.push({ url: requestUrl, error: abortError }));
    });
    pendingRoutes.add(task);
    return task.finally(() => pendingRoutes.delete(task));
  });

  const input = label => page.locator(`[aria-label=${JSON.stringify(label)}] input, input[aria-label=${JSON.stringify(label)}]`).first();
  const clickText = label => page.locator('taro-button-core, button, [role="button"]').filter({ has: page.getByText(label, { exact: true }) }).last().click();
  const go = async route => { await page.goto('about:blank'); await page.goto(origin + '/#' + route); };
  const choose = async (label, fragment) => {
    const picker = page.locator(`[aria-label=${JSON.stringify(label)}]`).first();
    await expect(picker).toBeVisible();
    if (await picker.evaluate(node => node.tagName === 'SELECT')) {
      const options = await picker.locator('option').allTextContents();
      const option = options.find(text => text.includes(fragment));
      assert.ok(option, `Missing option containing ${fragment} in ${label}: ${options.join(' | ')}`);
      await picker.selectOption({ label: option });
      return;
    }
    await picker.click();
    const wheel = page.locator('.weui-picker__group:visible').last();
    await expect(wheel).toBeVisible();
    await expect.poll(async () => { const bounds = await wheel.boundingBox(); return Math.round(bounds.y + bounds.height); }).toBe(page.viewportSize().height);
    const rows = wheel.locator('.weui-picker__item');
    const options = await rows.allTextContents();
    const targetIndex = options.findIndex(text => text.includes(fragment));
    assert.ok(targetIndex >= 0, `Missing picker row containing ${fragment} in ${label}: ${options.join(' | ')}`);
    const hiddenValue = Number(await picker.locator('input[type="hidden"]').inputValue());
    const delta = targetIndex - (Number.isFinite(hiddenValue) ? hiddenValue : 0);
    const box = await wheel.boundingBox();
    assert.ok(box, `Missing picker bounds for ${label}`);
    let remaining = delta;
    while (remaining !== 0) {
      const rowsToMove = Math.max(-6, Math.min(6, remaining));
      const x = box.x + box.width / 2;
      const startY = rowsToMove > 0 ? box.y + box.height - 5 : box.y + 5;
      await page.mouse.move(x, startY);
      await page.mouse.down();
      await page.mouse.move(x, startY - rowsToMove * 34, { steps: Math.max(2, Math.abs(rowsToMove)) });
      await page.mouse.up();
      remaining -= rowsToMove;
    }
    if (delta !== 0) await page.waitForTimeout(350);
    await page.locator('.weui-picker__action:visible').filter({ hasText: '确定' }).click();
    await expect(wheel).not.toBeVisible();
    await expect(picker).toContainText(fragment);
  };
  const assertNoOverflow = async width => {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => {
      const rootNode = document.querySelector('[data-testid="stock-entry-page"]');
      const inputOverflow = [...document.querySelectorAll('input, textarea')].filter(item => item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden').some(item => {
        const bounds = item.getBoundingClientRect();
        return bounds.left < -1 || bounds.right > innerWidth + 1;
      });
      return document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1 && (!rootNode || rootNode.scrollWidth <= rootNode.clientWidth + 1) && !inputOverflow;
    }), { message: `纸箱生产入库在 ${width}px 不应横向溢出` }).toBe(true);
    await page.screenshot({ path: path.join(evidence, `customer-spec-inbound-${width}.png`), fullPage: true });
  };
  const createCustomer = async (name, specs = []) => {
    await go('/pages/customers/index');
    await expect(page.getByTestId('customer-center')).toBeVisible();
    await page.getByTestId('customer-center-add').click();
    const editor = page.getByTestId('customer-editor');
    await expect(editor).toBeVisible();
    await editor.getByLabel('公司名称').locator('input').fill(name);
    for (let index = 0; index < specs.length; index += 1) {
      await editor.locator('[aria-label="添加客户规格"]').click();
      const row = index + 1;
      await editor.getByLabel(`规格 ${row} 货物名称`).locator('input').fill(specs[index].goods);
      await editor.getByLabel(`规格 ${row} 规格尺寸`).locator('input').fill(specs[index].specification);
      await editor.getByLabel(`规格 ${row} 材质`).locator('input').fill(specs[index].material);
      await editor.getByLabel(`规格 ${row} 单位`).locator('input').fill(specs[index].unit);
      if (specs[index].price !== null) await editor.getByLabel(`规格 ${row} 单价`).locator('input').fill(String(specs[index].price));
    }
    const write = page.waitForResponse(response => ['POST', 'PUT'].includes(response.request().method()) && /\/api\/customers(?:\/\d+)?$/.test(new URL(response.url()).pathname));
    await clickText('保存客户');
    const response = await write;
    assert.equal(response.status(), 200, `保存客户失败：${await response.text()}`);
    await expect(editor).toHaveCount(0);
    await expect.poll(() => db.listCustomers().find(customer => customer.name === name)?.id || 0).toBeGreaterThan(0);
    const customer = db.listCustomers().find(row => row.name === name);
    assert.ok(customer);
    await expect.poll(() => db.getCustomer(customer.id)?.specs?.length || 0).toBe(specs.length);
    return db.getCustomer(customer.id);
  };
  const openCarton = async customerName => {
    await go('/pages/inbound/index?kind=carton');
    await expect(page.getByText('纸箱生产入库', { exact: true })).toBeVisible();
    await expect(input('货物 1 本次完工数量')).toBeVisible();
    await choose('选择客户', customerName);
    await expect(page.getByText('选择已有商品', { exact: true })).toHaveCount(0);
  };
  const chooseCustomerSpec = (fragment, index = 1) => choose(`货物 ${index} 客户常用规格`, fragment);
  const saveReceipt = async (workOrder, quantity, manualPrice = null) => {
    await input('货物 1 本次完工数量').fill(String(quantity));
    if (manualPrice !== null) await input('货物 1 入库单价').fill(String(manualPrice));
    const actualPrice = Number(await input('货物 1 入库单价').inputValue());
    await expect(page.getByTestId('inbound-total-amount')).toContainText(`¥${(quantity * actualPrice).toFixed(2)}`);
    await clickText('更多信息');
    await input('生产工单编号').fill(workOrder);
    const responseWait = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/delivery-notes');
    await clickText('确认入库');
    const response = await responseWait;
    assert.equal(response.status(), 200, `保存入库失败：${await response.text()}`);
    const note = db.listDeliveryNotes().find(row => row.work_order_no === workOrder);
    assert.ok(note, `缺少入库单 ${workOrder}`);
    return note;
  };

  let primaryError;
  let cleanupError;
  let successMessage;
  try {
    assert.equal(db.listProducts().length, 0, 'E2E 必须从零库存商品开始');
    const longGoodsName = '客户专属长名称瓦楞纸箱采购入库回归';
    const customer = await createCustomer('浏览器规格新建客户', [
      { goods: longGoodsName, specification: '30×20×15 cm', material: '牛皮纸', unit: '个', price: 3.5 },
      { goods: '未报价客户纸箱', specification: '40×25×18 cm', material: '瓦楞纸', unit: '个', price: null },
      { goods: '零报价客户纸箱', specification: '35×24×16 cm', material: '白板纸', unit: '个', price: 0 }
    ]);
    assert.equal(customer.specs.length, 3);
    assert.equal(customer.specs[0].price, 3.5);
    assert.equal(customer.specs[1].price, null);
    assert.equal(customer.specs[2].price, 0);
    assert.equal(db.listProducts().length, 0, '通过客户管理建立资料和规格不得创建库存商品');
    assert.equal(apiRequests.filter(row => row.method === 'POST' && row.path === '/products').length, 0, '客户编辑不得向 /products 发 POST');

    const legacyCustomer = await createCustomer('旧尺寸本客户', []);
    assert.deepEqual(legacyCustomer.specs || [], [], '旧尺寸本客户账户不带账户规格');
    const dimensions = db.getCustomerDimensions();
    dimensions.customers.push({
      id: 'legacy-carton-customer-spec-e2e',
      name: legacyCustomer.name,
      specs: [{ id: 'legacy-carton-spec-e2e', goods: '旧尺寸本纸箱', size: '22×17×11', sizeUnit: 'cm', material: '瓦楞纸', unit: '个', kind: '成品' }]
    });
    db.updateCustomerDimensions(dimensions);

    const hiddenAccountSpec = { id: 'hidden-non-carton-spec', goods: '整卷包装纸', specification: '整卷', material: '牛皮纸', unit: '卷', price: 8 };
    db.updateCustomer(customer.id, { specs: [...db.getCustomer(customer.id).specs, hiddenAccountSpec] });

    await openCarton(customer.name);
    await expect(page.locator('[aria-label="货物 1 客户常用规格"]')).toBeVisible();
    await expect(input('货物 1 入库单价')).toHaveValue('');
    await chooseCustomerSpec('零报价客户纸箱');
    const zeroPrice = input('货物 1 入库单价');
    await expect(zeroPrice).toHaveValue('0');
    assert.equal(await zeroPrice.evaluate(node => Boolean(node.disabled || node.readOnly)), true, '数值 0 客户报价也必须只读');
    assert.equal(db.listProducts().length, 0, '选取客户规格不得在保存前建立库存商品');

    await chooseCustomerSpec(longGoodsName);
    const selectedSpecPicker = page.locator('[aria-label="货物 1 客户常用规格"]').first();
    const wrappedLines = await selectedSpecPicker.evaluate(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size;
    });
    assert.ok(wrappedLines >= 2, `长客户规格选项应换行显示（实际 ${wrappedLines} 行）`);
    assert.equal(db.listProducts().length, 0);
    for (const width of [320, 390, 1280]) await assertNoOverflow(width);
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(page.getByLabel('编辑入库客户规格')).toBeVisible();
    await expect(page.getByLabel('新增入库客户')).toBeVisible();
    const customerCountBeforeInline = db.listCustomers().length;
    await page.getByLabel('新增入库客户').click();
    const inlineNewCustomer = page.getByTestId('customer-editor');
    await expect(inlineNewCustomer).toBeVisible();
    await expect.poll(() => inlineNewCustomer.evaluate(editor => editor.contains(document.activeElement))).toBe(true);
    await inlineNewCustomer.getByLabel('收起基本资料').click();
    await expect(inlineNewCustomer.getByText('未填写公司名称', { exact: true })).toBeVisible();
    await inlineNewCustomer.getByLabel('展开基本资料').click();
    await inlineNewCustomer.getByLabel('展开备注').click();
    await expect(inlineNewCustomer.getByLabel('备注').locator('textarea')).toBeVisible();
    await inlineNewCustomer.getByLabel('收起备注').click();
    await inlineNewCustomer.locator('[aria-label="添加客户规格"]').click();
    const inlineSize = inlineNewCustomer.getByLabel('规格 1 规格尺寸').locator('input');
    await inlineSize.fill('30');
    await expect(inlineSize).toHaveValue('30×');
    await page.keyboard.press('Escape');
    await expect(inlineNewCustomer).toHaveCount(0);
    assert.equal(db.listCustomers().length, customerCountBeforeInline, '仅打开并取消 inline 客户资料不新增客户');
    await page.getByLabel('编辑入库客户规格').click();
    const inlineEditCustomer = page.getByTestId('customer-editor');
    await expect(inlineEditCustomer).toBeVisible();
    await expect(inlineEditCustomer.locator('[aria-label="添加客户规格"]')).toBeVisible();
    await inlineEditCustomer.getByText('取消', { exact: true }).click();
    await expect(inlineEditCustomer).toHaveCount(0);
    assert.equal(db.listProducts().length, 0, '打开客户规格编辑器不得创建商品');

    await choose('选择客户', legacyCustomer.name);
    await expect(page.locator('[aria-label="货物 1 客户常用规格"]')).toContainText('选择客户的纸箱规格');
    await expect(input('货物 1 入库单价')).toHaveValue('');
    await choose('选择客户', customer.name);
    await expect(page.locator('[aria-label="货物 1 客户常用规格"]')).toContainText('选择客户的纸箱规格');
    await expect(input('货物 1 入库单价')).toHaveValue('');
    await chooseCustomerSpec(longGoodsName);

    const pricedSpec = customer.specs.find(spec => spec.goods === longGoodsName);
    assert.ok(pricedSpec);
    await expect(input('货物 1 入库单价')).toHaveValue('3.5');
    assert.equal(await input('货物 1 入库单价').evaluate(node => Boolean(node.disabled || node.readOnly)), true);
    const first = await saveReceipt('CUSTOMER-SPEC-FIRST', 10);
    assert.equal(first.customer_id, customer.id);
    assert.equal(first.lines[0].customer_spec_id, pricedSpec.id);
    assert.equal(first.lines[0].customer_spec_snapshot.price, 3.5);
    assert.equal(first.lines[0].unit_price, 3.5);
    assert.equal(first.total_amount, 35);
    assert.equal(first.supplier_id, null);
    const firstProductId = first.lines[0].product_id;
    assert.ok(firstProductId);
    const firstProduct = db.getProduct(firstProductId);
    assert.equal(firstProduct.name, longGoodsName);
    assert.equal(firstProduct.category, '纸箱');
    assert.equal(firstProduct.specification, '30×20×15 cm');
    assert.equal(firstProduct.material, '牛皮纸');
    assert.equal(firstProduct.unit, '个');
    assert.equal(firstProduct.length, 300);
    assert.equal(firstProduct.width, 200);
    assert.equal(firstProduct.price, 0, '自动建立的库存商品基础价保持0，客户报价写入入库单');
    assert.equal(firstProduct.stock, 10);
    assert.equal(first.lines[0].square_meters, 0.6);
    assert.equal(db.getCustomer(customer.id).debt, 35);
    assert.equal(db.listProducts().length, 1);
    assert.equal(apiRequests.filter(row => row.method === 'POST' && row.path === '/products').length, 0, '浏览器不得调用商品管理新增接口');

    await openCarton(customer.name);
    await chooseCustomerSpec(longGoodsName);
    await expect(input('货物 1 入库单价')).toHaveValue('3.5');
    const second = await saveReceipt('CUSTOMER-SPEC-SECOND', 5);
    assert.equal(second.lines[0].product_id, firstProductId, '第二次入库必须复用同一纸箱SKU');
    assert.equal(db.listProducts().length, 1);
    assert.equal(db.getProduct(firstProductId).stock, 15);
    assert.equal(db.getCustomer(customer.id).debt, 52.5);
    assert.equal(db.getDeliveryNote(first.id).lines[0].unit_price, 3.5, '历史入库单价不应被后续资料变化覆盖');

    await openCarton(customer.name);
    await chooseCustomerSpec('未报价客户纸箱');
    const manualPrice = input('货物 1 入库单价');
    await expect(manualPrice).toHaveValue('');
    assert.equal(await manualPrice.evaluate(node => Boolean(node.disabled || node.readOnly)), false);
    await manualPrice.fill('2.1');
    await page.getByLabel('编辑入库客户规格').click();
    const profileRefreshEditor = page.getByTestId('customer-editor');
    await expect(profileRefreshEditor).toBeVisible();
    await profileRefreshEditor.getByLabel('联系人').locator('input').fill('资料刷新保留手工价');
    const profileRefreshWrite = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/customers/' + customer.id);
    const profileRefreshCustomers = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/production-inbound/customers' && response.status() === 200);
    await profileRefreshEditor.getByText('保存客户', { exact: true }).click();
    assert.equal((await profileRefreshWrite).status(), 200);
    assert.equal((await profileRefreshCustomers).status(), 200);
    await expect(profileRefreshEditor).toHaveCount(0);
    await expect(page.locator('[aria-label="货物 1 客户常用规格"]')).toContainText('未报价客户纸箱');
    await expect(input('货物 1 入库单价')).toHaveValue('2.1');
    const unpriced = await saveReceipt('CUSTOMER-SPEC-UNPRICED', 4, 2.25);
    assert.equal(unpriced.lines[0].customer_spec_snapshot.price, 2.25);
    assert.equal(unpriced.lines[0].unit_price, 2.25);
    assert.equal(unpriced.total_amount, 9);
    assert.equal(db.getCustomer(customer.id).debt, 61.5);
    assert.equal(db.getProduct(unpriced.lines[0].product_id).price, 0, '手工入库价不得改写商品基础价');

    await openCarton(customer.name);
    await chooseCustomerSpec('零报价客户纸箱');
    await expect(input('货物 1 入库单价')).toHaveValue('0');
    const zero = await saveReceipt('CUSTOMER-SPEC-ZERO', 3);
    assert.equal(zero.total_amount, 0);
    assert.equal(zero.lines[0].unit_price, 0);
    assert.equal(zero.lines[0].customer_spec_snapshot.price, 0);
    assert.equal(db.getCustomer(customer.id).debt, 61.5, '零报价入库不应产生应收');
    assert.equal(db.getProduct(zero.lines[0].product_id).stock, 3);

    await openCarton(legacyCustomer.name);
    await chooseCustomerSpec('旧尺寸本纸箱');
    await expect(input('货物 1 入库单价')).toHaveValue('');
    const legacyNote = await saveReceipt('CUSTOMER-SPEC-LEGACY', 2, 1.75);
    assert.match(legacyNote.lines[0].customer_spec_id, /^dimension:/);
    assert.equal(legacyNote.lines[0].customer_spec_snapshot.price, 1.75);
    assert.equal(legacyNote.total_amount, 3.5);
    assert.equal(db.getCustomer(legacyCustomer.id).debt, 3.5);
    assert.equal(db.getProduct(legacyNote.lines[0].product_id).name, '旧尺寸本纸箱');
    assert.equal(db.getProduct(legacyNote.lines[0].product_id).length, 220);
    assert.equal(db.getProduct(legacyNote.lines[0].product_id).width, 170);

    const productsBeforeInlineCreate = db.listProducts().length;
    await openCarton(customer.name);
    await page.getByLabel('新增入库客户').click();
    const inlineCustomerEditor = page.getByTestId('customer-editor');
    await expect(inlineCustomerEditor).toBeVisible();
    await inlineCustomerEditor.getByLabel('公司名称').locator('input').fill('内联新建入库客户');
    await inlineCustomerEditor.locator('[aria-label="添加客户规格"]').click();
    await inlineCustomerEditor.getByLabel('规格 1 货物名称').locator('input').fill('内联新建纸箱');
    await inlineCustomerEditor.getByLabel('规格 1 规格尺寸').locator('input').fill('28×18×12 cm');
    await inlineCustomerEditor.getByLabel('规格 1 材质').locator('input').fill('黄板纸');
    await inlineCustomerEditor.getByLabel('规格 1 单位').locator('input').fill('个');
    await inlineCustomerEditor.getByLabel('规格 1 单价').locator('input').fill('4.25');
    const createCustomerResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/customers');
    await inlineCustomerEditor.getByText('保存客户', { exact: true }).click();
    assert.equal((await createCustomerResponse).status(), 200);
    await expect(inlineCustomerEditor).toHaveCount(0);
    await expect.poll(() => db.listCustomers().find(row => row.name === '内联新建入库客户')?.specs?.length || 0).toBe(1);
    const inlineCustomer = db.listCustomers().find(row => row.name === '内联新建入库客户');
    assert.ok(inlineCustomer);
    await expect(page.locator('[aria-label="选择客户"]')).toContainText(inlineCustomer.name);
    await expect(page.locator('[aria-label="货物 1 客户常用规格"]')).toContainText('选择客户的纸箱规格');
    await chooseCustomerSpec('内联新建纸箱');
    await expect(input('货物 1 入库单价')).toHaveValue('4.25');
    const inlineNote = await saveReceipt('CUSTOMER-SPEC-INLINE-CREATE', 6);
    assert.equal(inlineNote.customer_id, inlineCustomer.id);
    assert.equal(inlineNote.total_amount, 25.5);
    assert.equal(db.getCustomer(inlineCustomer.id).debt, 25.5);
    assert.equal(db.listProducts().length, productsBeforeInlineCreate + 1);

    await openCarton(customer.name);
    await page.getByLabel('编辑入库客户规格').click();
    const inlineEdit = page.getByTestId('customer-editor');
    await expect(inlineEdit).toBeVisible();
    await inlineEdit.getByLabel('规格 1 单价').locator('input').fill('3.75');
    await inlineEdit.locator('[aria-label="添加客户规格"]').click();
    await inlineEdit.getByLabel('规格 4 货物名称').locator('input').fill('内联补录纸箱');
    await inlineEdit.getByLabel('规格 4 规格尺寸').locator('input').fill('26×16×10 cm');
    await inlineEdit.getByLabel('规格 4 材质').locator('input').fill('灰板纸');
    await inlineEdit.getByLabel('规格 4 单位').locator('input').fill('个');
    await inlineEdit.getByLabel('规格 4 单价').locator('input').fill('1e5');
    await expect(inlineEdit.getByLabel('规格 4 单价').locator('input')).toHaveValue('');
    await inlineEdit.getByLabel('规格 4 单价').locator('input').fill('2.75');
    const updateCustomerResponse = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/customers/' + customer.id + '/specs');
    const refreshCustomersResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/production-inbound/customers' && response.status() === 200);
    await inlineEdit.getByText('保存客户', { exact: true }).click();
    assert.equal((await updateCustomerResponse).status(), 200);
    assert.equal((await refreshCustomersResponse).status(), 200);
    await expect(inlineEdit).toHaveCount(0);
    await expect.poll(() => db.getCustomer(customer.id).specs.length).toBe(5);
    assert.deepEqual(db.getCustomer(customer.id).specs.find(spec => spec.id === hiddenAccountSpec.id), hiddenAccountSpec, '编辑纸箱规格必须保留不可见的历史账户规格');
    assert.equal(db.getCustomer(customer.id).specs.find(spec => spec.goods === longGoodsName).price, 3.75, '已有客户规格必须可编辑并持久化');
    await expect(page.locator('[aria-label="货物 1 客户常用规格"]')).toBeVisible();
    await chooseCustomerSpec('内联补录纸箱');
    await expect(input('货物 1 入库单价')).toHaveValue('2.75');

    await openCarton(legacyCustomer.name);
    await page.getByLabel('编辑入库客户规格').click();
    const legacyEditor = page.getByTestId('customer-editor');
    await expect(legacyEditor).toBeVisible();
    await expect(legacyEditor.getByLabel('规格 1 货物名称').locator('input')).toHaveValue('旧尺寸本纸箱');
    await expect(legacyEditor.getByLabel('规格 1 规格尺寸').locator('input')).toHaveValue('22×17×11 cm');
    assert.equal(await legacyEditor.getByLabel('规格 1 货物名称').locator('input').evaluate(node => Boolean(node.disabled || node.readOnly)), true, '旧尺寸库规格应只读，避免保存到错误数据源');
    await legacyEditor.getByLabel('删除客户规格 1').click();
    const legacyDelete = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/customers/' + legacyCustomer.id + '/specs');
    await legacyEditor.getByText('保存客户', { exact: true }).click();
    assert.equal((await legacyDelete).status(), 200);
    await expect(legacyEditor).toHaveCount(0);
    assert.equal(db.getCustomerDimensions().customers.find(row => row.id === 'legacy-carton-customer-spec-e2e').specs.length, 0, '删除旧尺寸库规格后必须持久化，刷新不能重新出现');
    await expect(page.locator('[aria-label="货物 1 客户常用规格"]')).toContainText('暂无纸箱规格');
    await page.locator('[aria-label="货物 1 客户常用规格"]').click();
    const emptySpecEditor = page.getByTestId('customer-editor');
    await expect(emptySpecEditor).toBeVisible();
    await expect(emptySpecEditor.getByText('编辑客户资料', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(emptySpecEditor).toHaveCount(0);

    await openCarton(customer.name);
    await page.getByLabel('编辑入库客户规格').click();
    const concurrentEditor = page.getByTestId('customer-editor');
    await concurrentEditor.locator('[aria-label="添加客户规格"]').click();
    await concurrentEditor.getByLabel('规格 5 货物名称').locator('input').fill('并发修改纸箱');
    await concurrentEditor.getByLabel('规格 5 规格尺寸').locator('input').fill('24×14×9 cm');
    await concurrentEditor.getByLabel('规格 5 材质').locator('input').fill('黄板纸');
    await concurrentEditor.getByLabel('规格 5 单位').locator('input').fill('个');
    await concurrentEditor.getByLabel('规格 5 单价').locator('input').fill('1.5');
    db.updateCustomer(customer.id, { contact: '外部设备修改联系人' });
    await concurrentEditor.getByText('保存客户', { exact: true }).click();
    await expect(concurrentEditor.getByText(/其他设备更新/)).toBeVisible();
    await expect(concurrentEditor).toBeVisible();
    await expect(concurrentEditor.getByText('重新读取', { exact: true })).toBeVisible();
    const conflictReload = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/production-inbound/customers' && response.status() === 200);
    await concurrentEditor.getByText('重新读取', { exact: true }).click();
    await conflictReload;
    await expect(concurrentEditor.getByText(/其他设备更新/)).toHaveCount(0);
    await expect(concurrentEditor.getByLabel('联系人').locator('input')).toHaveValue('外部设备修改联系人');
    await concurrentEditor.getByText('取消', { exact: true }).click();
    assert.equal(db.getCustomer(customer.id).contact, '外部设备修改联系人');

    failCartonCustomerRead = true;
    const failedCustomerLoad = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/production-inbound/customers' && response.status() === 503
    );
    await go('/pages/inbound/index?kind=carton');
    await failedCustomerLoad;
    await expect(page.locator('[role="alert"]')).toBeVisible();
    failCartonCustomerRead = false;
    const retriedCustomerLoad = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/production-inbound/customers' && response.status() === 200
    );
    await clickText('重新读取');
    await retriedCustomerLoad;
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    await choose('选择客户', customer.name);
    await expect(page.locator('[aria-label="货物 1 客户常用规格"]')).toContainText('选择客户的纸箱规格');
    await chooseCustomerSpec('内联补录纸箱');
    await expect(input('货物 1 入库单价')).toHaveValue('2.75');

    await expect.poll(() => db.getDeliveryNote(first.id).lines[0].unit_price).toBe(3.5);
    assert.equal(apiRequests.filter(row => row.method === 'POST' && row.path === '/products').length, 0, '整个流程不得从UI创建商品');
    assert.deepEqual(pageErrors, []);
    assert.ok(externalBlocked.every(request => !request.includes('youxishen.online')), '跨域静态请求不得触达生产域名');
    successMessage = 'PASS: 客户与规格建档、纸箱入库直接选规格、报价/未报价/零报价、自动复用/认领SKU、旧尺寸本删除持久化、隐藏规格保留、客户切换、内联新增/编辑、手工价刷新保留、并发恢复、键盘焦点/ESC、接口失败重试、320/390/1280响应式布局。';
  } catch (error) {
    primaryError = error;
    await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure-text.txt'), await page.locator('body').innerText().catch(() => ''));
    fs.writeFileSync(path.join(evidence, 'failure.html'), await page.content().catch(() => ''));
  } finally {
    try {
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
    if (!primaryError && pageErrors.length) cleanupError ||= new Error('Browser page error(s): ' + pageErrors.join('; '));
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temporary, { recursive: true, force: true });
    delete require.cache[require.resolve(dbPath)];
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  console.log(successMessage);
}

main().catch(error => {
  console.error(error);
  if (process.env.GITHUB_ACTIONS === 'true') {
    const detail = String(error?.stack || error).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error('::error file=tests/customer-spec-carton-inbound-browser.cjs,title=Customer specification carton inbound browser acceptance::' + detail);
  }
  process.exitCode = 1;
});


