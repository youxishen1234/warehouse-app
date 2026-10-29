const { openGoods, chooseReceipt } = require('./receipt-ui-actions.cjs');
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

  const input = label => page.locator(`[aria-label=${JSON.stringify(label.replace('货物名称', '纸箱名称（必填）'))}] input, input[aria-label=${JSON.stringify(label.replace('货物名称', '纸箱名称（必填）'))}]`).first();
  const clickText = label => page.locator('taro-button-core, button, [role="button"]').filter({ hasText: label }).last().click();
  const go = async route => { await page.goto('about:blank'); await page.goto(origin + '/#' + route); };
  const choose = (label, fragment) => chooseReceipt(page, label, fragment);
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
    await editor.getByLabel('公司名称').locator('xpath=self::input | .//input').fill(name);
    for (let index = 0; index < specs.length; index += 1) {
      if (index === 0) await editor.locator('details').filter({ has: page.getByText('常用货物', { exact: true }) }).locator('summary').click();
      await editor.locator('[aria-label="添加客户规格"]').click();
      const row = index + 1;
      await editor.getByLabel(`规格 ${row} 货物名称`).locator('xpath=self::input | .//input').fill(specs[index].goods);
      await editor.getByLabel(`规格 ${row} 规格尺寸`).locator('xpath=self::input | .//input').fill(specs[index].specification);
      await editor.getByLabel(`规格 ${row} 材质`).locator('xpath=self::input | .//input').fill(specs[index].material);
      await editor.getByLabel(`规格 ${row} 单位`).locator('xpath=self::input | .//input').fill(specs[index].unit);
      if (specs[index].price !== null) await editor.getByLabel(`规格 ${row} 单价`).locator('xpath=self::input | .//input').fill(String(specs[index].price));
    }
    const write = page.waitForResponse(response => ['POST', 'PUT'].includes(response.request().method()) && /\/api\/customers(?:\/\d+)?$/.test(new URL(response.url()).pathname));
    await clickText('保存客户资料');
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
    await go('/pages/carton-inbound/index');
    await expect(page.getByRole('heading', { name: '纸箱入库', exact: true })).toBeVisible();
    await expect(input('货物 1 本次完工数量')).toBeVisible();
    await choose('选择客户', customerName);
    await expect(page.getByLabel('常用货物', { exact: true })).toBeVisible();
  };
  const chooseCustomerSpec = (fragment, index = 1) => choose(`货物 ${index} 客户常用规格`, fragment);
  const saveReceipt = async (workOrder, quantity, manualPrice = null) => {
    await input('货物 1 本次完工数量').fill(String(quantity));
    if (manualPrice !== null) await input('货物 1 入库单价').fill(String(manualPrice));
    const actualPrice = Number(await input('货物 1 入库单价').inputValue());
    await expect(page.getByTestId('inbound-total-amount')).toContainText(`¥${(quantity * actualPrice).toFixed(2)}`);
    const create = page.getByText('创建并关联商品', { exact: true });
    if (await create.count()) {
      await create.click(); await page.locator('.taro-model__confirm:visible').click();
    }
    await page.locator('.demo-dialog summary').filter({ hasText: '更多信息' }).click();
    await input('工单编号或采购单号').fill(workOrder);
    const responseWait = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/delivery-notes');
    await clickText('确认纸箱入库');
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
    await expect(page.getByLabel('常用货物', { exact: true })).toBeVisible();
    await openGoods(page);
    await expect(input('货物 1 入库单价')).toHaveValue('');
    await chooseCustomerSpec('零报价客户纸箱');
    const zeroPrice = input('货物 1 入库单价');
    await expect(zeroPrice).toHaveValue('0');
    assert.equal(await zeroPrice.evaluate(node => Boolean(node.disabled || node.readOnly)), false, '入库成本可调整，不能锁定为客户报价');
    assert.equal(db.listProducts().length, 0, '选取客户规格不得在保存前建立库存商品');

    await chooseCustomerSpec(longGoodsName);
    assert.equal(db.listProducts().length, 0);
    for (const width of [320, 390, 1280]) await assertNoOverflow(width);
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(page.getByLabel('新增入库客户')).toHaveCount(0);
    await expect(page.getByTestId('customer-editor')).toHaveCount(0);

    const pricedSpec = customer.specs.find(spec => spec.goods === longGoodsName);
    assert.ok(pricedSpec);
    await expect(input('货物 1 入库单价')).toHaveValue('3.5');
    assert.equal(await input('货物 1 入库单价').evaluate(node => Boolean(node.disabled || node.readOnly)), false);
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
    assert.equal(db.getCustomer(customer.id).debt, 0);
    assert.equal(db.listProducts().length, 1);
    assert.equal(apiRequests.filter(row => row.method === 'POST' && row.path === '/products').length, 0, '浏览器不得调用商品管理新增接口');

    await openCarton(customer.name);
    await chooseCustomerSpec(longGoodsName);
    await expect(input('货物 1 入库单价')).toHaveValue('3.5');
    const second = await saveReceipt('CUSTOMER-SPEC-SECOND', 5);
    assert.equal(second.lines[0].product_id, firstProductId, '第二次入库必须复用同一纸箱SKU');
    assert.equal(db.listProducts().length, 1);
    assert.equal(db.getProduct(firstProductId).stock, 15);
    assert.equal(db.getCustomer(customer.id).debt, 0);
    assert.equal(db.getDeliveryNote(first.id).lines[0].unit_price, 3.5, '历史入库单价不应被后续资料变化覆盖');

    await openCarton(customer.name);
    await chooseCustomerSpec('未报价客户纸箱');
    const manualPrice = input('货物 1 入库单价');
    await expect(manualPrice).toHaveValue('');
    assert.equal(await manualPrice.evaluate(node => Boolean(node.disabled || node.readOnly)), false);
    await manualPrice.fill('2.1');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(input('货物 1 入库单价')).toHaveValue('2.1');
    const unpriced = await saveReceipt('CUSTOMER-SPEC-UNPRICED', 4, 2.25);
    assert.equal(unpriced.lines[0].customer_spec_snapshot.price, 2.25);
    assert.equal(unpriced.lines[0].unit_price, 2.25);
    assert.equal(unpriced.total_amount, 9);
    assert.equal(db.getCustomer(customer.id).debt, 0);
    assert.equal(db.getProduct(unpriced.lines[0].product_id).price, 0, '手工入库价不得改写商品基础价');

    await openCarton(customer.name);
    await chooseCustomerSpec('零报价客户纸箱');
    await expect(input('货物 1 入库单价')).toHaveValue('0');
    const zero = await saveReceipt('CUSTOMER-SPEC-ZERO', 3);
    assert.equal(zero.total_amount, 0);
    assert.equal(zero.lines[0].unit_price, 0);
    assert.equal(zero.lines[0].customer_spec_snapshot.price, 0);
    assert.equal(db.getCustomer(customer.id).debt, 0, '纸箱入库不应产生应收');
    assert.equal(db.getProduct(zero.lines[0].product_id).stock, 3);

    await openCarton(legacyCustomer.name);
    await chooseCustomerSpec('旧尺寸本纸箱');
    await openGoods(page);
    await expect(input('货物 1 入库单价')).toHaveValue('');
    const legacyNote = await saveReceipt('CUSTOMER-SPEC-LEGACY', 2, 1.75);
    assert.match(legacyNote.lines[0].customer_spec_id, /^dimension:/);
    assert.equal(legacyNote.lines[0].customer_spec_snapshot.price, 1.75);
    assert.equal(legacyNote.total_amount, 3.5);
    assert.equal(db.getCustomer(legacyCustomer.id).debt, 0);
    assert.equal(db.getProduct(legacyNote.lines[0].product_id).name, '旧尺寸本纸箱');
    assert.equal(db.getProduct(legacyNote.lines[0].product_id).length, 220);
    assert.equal(db.getProduct(legacyNote.lines[0].product_id).width, 170);

    await openCarton(customer.name);
    await expect(page.getByLabel('新增入库客户')).toHaveCount(0);
    await expect(page.getByLabel('编辑入库客户规格')).toHaveCount(0);
    failCartonCustomerRead = true;
    const failedCustomerLoad = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/production-inbound/customers' && response.status() === 503
    );
    await go('/pages/carton-inbound/index');
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
    await expect(page.getByLabel('常用货物', { exact: true })).toBeVisible();
    await chooseCustomerSpec(longGoodsName);
    await expect(input('货物 1 入库单价')).toHaveValue('3.5');

    await expect.poll(() => db.getDeliveryNote(first.id).lines[0].unit_price).toBe(3.5);
    assert.equal(apiRequests.filter(row => row.method === 'POST' && row.path === '/products').length, 0, '整个流程不得从UI创建商品');
    assert.deepEqual(pageErrors, []);
    assert.ok(externalBlocked.every(request => !request.includes('youxishen.online')), '跨域静态请求不得触达生产域名');
    successMessage = 'PASS: management-only party creation, searchable customer selection and cards, explicit SKU creation/reuse, quote/manual/zero price snapshots, legacy dimensions, draft price refresh, failed-load retry, 320/390/1280 layouts.';
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


