const { openGoods, chooseQuickReceipt } = require('./receipt-ui-actions.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function main() {
  const webRoot = path.resolve(process.env.CARTON_PRODUCTION_WEB_DIR || process.env.TARO_OUTPUT_DIR || path.join(root, 'dist'));
  const evidence = path.resolve(process.env.CARTON_PRODUCTION_EVIDENCE_DIR || path.join(root, 'release/carton-production-inbound/evidence'));
  if (!fs.existsSync(path.join(webRoot, 'index.html'))) throw new Error(`H5 构建目录缺少 index.html: ${webRoot}`);
  fs.mkdirSync(evidence, { recursive: true });

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-carton-production-browser-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], ledger: []
  }));

  const dbPath = path.join(root, 'backend/db');
  delete require.cache[require.resolve(dbPath)];
  const db = require(dbPath);
  const apiRequests = [];
  const app = express();
  app.use(express.json({ limit: '18mb' }));
  app.use('/api', (req, res, next) => {
    apiRequests.push({ method: req.method, path: req.path, body: req.body });
    next();
  });
  app.use('/api', require(path.join(root, 'backend/team'))(db));
  app.use(express.static(webRoot));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {});
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'zh-CN' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  const externalBlocked = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  const supplier = db.addSupplier({ name: '历史采购供货商' });
  const customer = db.addCustomer({ name: '历史客户供箱方' });
  const legacyPurchaseProduct = db.addProduct({
    name: '历史采购纸箱',
    category: '纸箱',
    specification: '10×8×6',
    unit: '个',
    price: 3,
    stock: 0
  });
  const legacyCustomerProduct = db.addProduct({
    name: '历史客户供箱',
    category: '纸箱',
    specification: '12×9×7',
    unit: '个',
    price: 2,
    stock: 0
  });
  const cartonProduct = db.addProduct({
    name: '自产测试纸箱甲',
    material: '牛皮纸',
    category: '纸箱',
    specification: '20×15×10',
    unit: '个',
    price: 2.5,
    stock: 5
  });
  const finishedProduct = db.addProduct({
    name: '自产测试成品乙',
    material: '牛皮纸',
    category: '成品',
    specification: '18×12×8',
    unit: '个',
    price: 1.4,
    stock: 4
  });
  const date = localDate();
  const legacyPurchase = db.addDeliveryNote({
    date,
    work_order_no: 'LEGACY-SUPPLIER-INBOUND',
    supplier_id: supplier.id,
    operator: '隔离测试',
    freight: 0,
    lines: [{ product_id: legacyPurchaseProduct.id, quantity: 2, delivered_qty: 2, unit_price: 3 }]
  });
  const legacyCustomerSupply = db.addDeliveryNote({
    date,
    work_order_no: 'LEGACY-CUSTOMER-SUPPLY',
    party_type: 'customer',
    customer_id: customer.id,
    operator: '隔离测试',
    freight: 0,
    lines: [{ product_id: legacyCustomerProduct.id, quantity: 3, delivered_qty: 3, unit_price: 2 }]
  });
  assert.notEqual(legacyPurchase.source_type, 'production');
  assert.notEqual(legacyCustomerSupply.source_type, 'production');
  const baseline = {
    supplierPayable: db.getSupplier(supplier.id).payable,
    customerDebt: db.getCustomer(customer.id).debt,
    ledger: db.listLedger({ include_voided: 'true' }).map(entry => ({ ...entry })),
    cartonStock: db.getProduct(cartonProduct.id).stock,
    finishedStock: db.getProduct(finishedProduct.id).stock,
    productionCount: db.listProduction().length
  };

  const externalApiPath = pathname => pathname.startsWith('/api/');
  const corsHeaders = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'Authorization,Content-Type,If-Match,Idempotency-Key,X-Warehouse-Device',
    'access-control-expose-headers': 'X-Warehouse-Revision'
  };

  try {
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (/^https?:$/.test(url.protocol) && externalApiPath(url.pathname)) {
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: corsHeaders });
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), ...corsHeaders } });
      }
      if (/^https?:$/.test(url.protocol)) externalBlocked.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    });

    const input = label => page.locator(`[aria-label=${JSON.stringify(label)}] input, input[aria-label=${JSON.stringify(label)}]`).first();
    const buttonContainingText = label => page.locator('taro-button-core, button').filter({ hasText: label }).last();
    const productionPath = '/#/pages/carton-inbound/index';
    const openProductionEntry = async () => {
      await page.goto(`${origin}${productionPath}`);
      await expect(page.getByTestId('carton-receipt-sheet')).toBeVisible();
      await expect(page.getByRole('heading', { name: '纸箱入库', exact: true })).toBeVisible();
      await expect(input('货物 1 本次完工数量')).toBeVisible();
      await openGoods(page); await expect(input('货物 1 入库单价')).toBeVisible();
    };
    const openProductPickerAndSelect = async name => {
      const index = await page.getByTestId(/^inbound-line-\d+$/).count();
      await chooseQuickReceipt(page, name, { index, kind: 'product' });
      await openGoods(page, index);
    };
    const showMore = async () => {
      const details = page.locator('.demo-dialog details').filter({ has: page.getByText('更多信息', { exact: true }) });
      if (!await details.evaluate(el => el.open)) await details.locator('summary').click();
    };
    const showHistory = async () => {
      const details = page.locator('.demo-dialog details').filter({ has: page.getByText('最近入库单', { exact: true }) });
      if (!await details.evaluate(el => el.open)) await details.locator('summary').click();
      await details.getByRole('button', { name: '读取记录', exact: true }).click();
    };
    const expectedLineAmount = async (lineIndex, amount) => {
      await expect(page.locator(`[data-testid="inbound-line-amount-${lineIndex + 1}"]`)).toContainText(`¥${amount}`);
    };
    const expectedTotal = async amount => {
      await expect(page.locator('[data-testid="inbound-total-amount"]')).toContainText(`¥${amount}`);
    };
    const countCartonInboundCustomerRequests = () => apiRequests.filter(item =>
      item.method === 'GET' && item.path === '/production-inbound/customers'
    ).length;
    const assertNoOverflow = async width => {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(() => {
        const rootNode = document.querySelector('[data-testid="stock-entry-page"]');
        const inputOverflow = [...document.querySelectorAll('input, textarea')]
          .filter(item => item.getClientRects().length > 0 && getComputedStyle(item).visibility !== 'hidden')
          .some(item => {
            const bounds = item.getBoundingClientRect();
            return bounds.left < -1 || bounds.right > innerWidth + 1;
          });
        return document.documentElement.scrollWidth <= innerWidth + 1
          && document.body.scrollWidth <= innerWidth + 1
          && (!rootNode || rootNode.scrollWidth <= rootNode.clientWidth + 1)
          && !inputOverflow;
      }), { message: `纸箱生产入库在 ${width}px 不应横向溢出` }).toBe(true);
      await page.locator('.demo-dialog-head').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(evidence, `carton-production-${width}.png`), fullPage: true });
    };

    await openProductionEntry();
    await expect(page.getByLabel('关联客户', { exact: true })).toBeVisible();
    assert.ok(countCartonInboundCustomerRequests() > 0);
    assert.ok(apiRequests.some(item => item.method === 'GET' && item.path.startsWith('/suppliers')));
    await showMore();
    await expect(page.getByLabel('供货来源', { exact: true })).toBeVisible();
    await expect(input('工单编号或采购单号')).toBeVisible();
    await expect(input('货物 1 计划数量')).toBeVisible();
    await expect(input('入库备注')).toBeVisible();

    await openProductPickerAndSelect('自产测试纸箱甲');
    const firstSpec = input('货物 1 规格尺寸');
    await firstSpec.fill('');
    await firstSpec.pressSequentially('302015');
    await expect(firstSpec).toHaveValue('30×20×15');
    await openProductPickerAndSelect('自产测试纸箱甲');
    await expect(firstSpec).toHaveValue('20×15×10');

    const firstQuantity = input('货物 1 本次完工数量');
    const firstPrice = input('货物 1 入库单价');
    await expect(firstPrice).toHaveValue('2.5');
    await firstQuantity.fill('2.5');
    await expectedLineAmount(0, '6.25');
    await firstPrice.fill('1.23');
    await expectedLineAmount(0, '3.08');
    await expectedTotal('3.08');

    await buttonContainingText('再添加一项').click();
    await openProductPickerAndSelect('自产测试成品乙');
    const secondQuantity = input('货物 2 本次完工数量');
    const secondPrice = input('货物 2 入库单价');
    await secondQuantity.fill('3');
    await expectedLineAmount(1, '4.20');
    await expectedTotal('7.28');
    await secondPrice.fill('0');
    await expectedLineAmount(1, '0.00');
    await expectedTotal('3.08');
    await secondPrice.fill('1.4');
    await expectedLineAmount(1, '4.20');
    await expectedTotal('7.28');

    await input('工单编号或采购单号').fill('PROD-BROWSER-20261023-01');

    await showHistory();
    await expect(page.getByText('暂无入库单', { exact: true })).toBeVisible();

    await assertNoOverflow(320);
    await assertNoOverflow(390);
    await page.setViewportSize({ width: 390, height: 900 });
    const saveButton = buttonContainingText('确认纸箱入库');
    await expect(saveButton).toBeEnabled();
    const productionPostsBefore = apiRequests.filter(item => item.method === 'POST' && item.path === '/delivery-notes').length;
    const postResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/delivery-notes');
    await saveButton.dblclick({ delay: 60 });
    const postedResponse = await postResponse;
    const postedResponseBody = await postedResponse.json();
    assert.equal(postedResponse.status(), 200, `生产入库请求应由隔离后端成功处理：${JSON.stringify(postedResponseBody)}`);
    await expect(page.getByText('入库单 #', { exact: false }).first()).toBeVisible();
    await expect.poll(() => apiRequests.filter(item => item.method === 'POST' && item.path === '/delivery-notes').length - productionPostsBefore).toBe(1);

    const newPost = apiRequests.filter(item => item.method === 'POST' && item.path === '/delivery-notes').at(-1);
    assert.equal(newPost.body.source_type, 'production', 'UI 必须提交自产来源');
    assert.equal(newPost.body.party_type, null, '自产单不得绑定往来类型');
    assert.equal(newPost.body.customer_id, null);
    assert.equal(newPost.body.supplier_id, null);
    assert.equal(newPost.body.customer_name, '');
    assert.equal(newPost.body.supplier_name, '');
    assert.equal(newPost.body.driver_phone, '');
    assert.equal(newPost.body.vehicle_no, '');
    assert.equal(newPost.body.freight, 0);
    assert.equal(newPost.body.work_order_no, 'PROD-BROWSER-20261023-01');
    assert.equal(newPost.body.lines[0].specification, '20×15×10');
    assert.equal(newPost.body.lines[0].delivered_qty, 2.5);
    assert.equal(newPost.body.lines[0].unit_price, 1.23);
    assert.equal(newPost.body.lines[1].delivered_qty, 3);
    assert.equal(newPost.body.lines[1].unit_price, 1.4);

    const productionNote = db.listDeliveryNotes().find(note => note.work_order_no === 'PROD-BROWSER-20261023-01');
    assert.ok(productionNote, '保存应生成纸箱自产入库单据');
    assert.equal(productionNote.source_type, 'production');
    assert.equal(productionNote.party_type, null);
    assert.equal(productionNote.customer_id, null);
    assert.equal(productionNote.supplier_id, null);
    assert.equal(productionNote.customer_name, '');
    assert.equal(productionNote.supplier_name, '');
    assert.equal(productionNote.total_amount, 7.28, '服务端应按各行完工数 × 入库单价取金额后求和');
    assert.deepEqual(productionNote.lines.map(line => line.amount), [3.08, 4.2]);
    assert.deepEqual(productionNote.lines.map(line => line.specification), ['20×15×10', '18×12×8']);
    assert.equal(db.getProduct(cartonProduct.id).stock, baseline.cartonStock + 2.5);
    assert.equal(db.getProduct(finishedProduct.id).stock, baseline.finishedStock + 3);
    assert.equal(db.getSupplier(supplier.id).payable, baseline.supplierPayable, '自产金额不得增加历史供货商应付');
    assert.equal(db.getCustomer(customer.id).debt, baseline.customerDebt, '自产金额不得增加历史客户应收');
    assert.deepEqual(db.listLedger({ include_voided: 'true' }).map(entry => ({ ...entry })), baseline.ledger, '自产单不得新增或变更任何账本记录');
    assert.equal(db.listProduction().length, baseline.productionCount, '自产入库不应伪造独立完整生产工单记录');
    assert.ok(productionNote.lines.every(line => line.transaction_id), '每条正数自产入库行应关联库存流水');
    const transactionIds = new Set(productionNote.lines.map(line => line.transaction_id));
    assert.ok(db.listTx({}).filter(tx => transactionIds.has(tx.id)).every(tx => tx.delivery_note_id === productionNote.id && tx.type === 'in'), '生产入库只生成与原单关联的成品入库流水');
    assert.equal(db.listLedger({ include_voided: 'true' }).some(entry => transactionIds.has(entry.transaction_id)), false, '自产库存流水不得链接应付/应收账');

    await expect(page.getByText('PROD-BROWSER-20261023-01', { exact: false }).last()).toBeVisible();
    await expect(page.getByText('LEGACY-SUPPLIER-INBOUND', { exact: false })).toHaveCount(0);
    await expect(page.getByText('LEGACY-CUSTOMER-SUPPLY', { exact: false })).toHaveCount(0);
    await page.screenshot({ path: path.join(evidence, 'carton-production-saved.png'), fullPage: true });

    await page.goto(`${origin}/#/pages/carton-inbound/index?kind=purchase`);
    await expect(page.getByRole('heading', { name: '库存入库', exact: true })).toBeVisible();
    await showHistory();
    await expect(page.getByText('LEGACY-SUPPLIER-INBOUND', { exact: false }).last()).toBeVisible();
    await expect(page.getByText('LEGACY-CUSTOMER-SUPPLY', { exact: false }).last()).toBeVisible();

    const customerRequestsBeforeReenter = countCartonInboundCustomerRequests();
    const supplierRequestsBeforeReenter = apiRequests.filter(item => item.method === 'GET' && item.path.startsWith('/suppliers')).length;
    await openProductionEntry();
    assert.ok(countCartonInboundCustomerRequests() >= customerRequestsBeforeReenter, '重新打开纸箱生产页面仍只从生产入库客户接口读取客户');
    assert.ok(apiRequests.filter(item => item.method === 'GET' && item.path.startsWith('/suppliers')).length > supplierRequestsBeforeReenter, '重新打开时刷新供货来源');
    await showHistory();
    await expect(page.getByText('PROD-BROWSER-20261023-01', { exact: false }).last()).toBeVisible();
    await expect(page.getByText('LEGACY-SUPPLIER-INBOUND', { exact: false })).toHaveCount(0);
    await expect(page.getByText('LEGACY-CUSTOMER-SUPPLY', { exact: false })).toHaveCount(0);
    await page.getByText('PROD-BROWSER-20261023-01', { exact: false }).last().click();
    const voidButton = buttonContainingText('作废整张入库单');
    await expect(voidButton).toBeVisible();
    await voidButton.click();
    const voidModal = page.locator('.taro-modal__content:visible').last();
    await expect(voidModal).toBeVisible();
    await voidModal.locator('.taro-model__confirm').click();
    await expect.poll(() => apiRequests.some(item => item.method === 'DELETE' && item.path === `/delivery-notes/${productionNote.id}`)).toBe(true);
    await expect.poll(() => db.getDeliveryNote(productionNote.id).voided_at).toBeGreaterThan(0);
    assert.equal(db.getProduct(cartonProduct.id).stock, baseline.cartonStock, '作废自产单应完整撤回纸箱库存');
    assert.equal(db.getProduct(finishedProduct.id).stock, baseline.finishedStock, '作废自产单应完整撤回成品库存');
    assert.equal(db.getSupplier(supplier.id).payable, baseline.supplierPayable);
    assert.equal(db.getCustomer(customer.id).debt, baseline.customerDebt);
    assert.deepEqual(db.listLedger({ include_voided: 'true' }).map(entry => ({ ...entry })), baseline.ledger, '作废自产单仍不得生成往来账');

    // Exercise a separate zero-valued receipt so that a free in-house product
    // is accepted and still follows the same idempotent, stock-only workflow.
    await openProductionEntry();
    await showMore();
    await expect(input('工单编号或采购单号')).toBeVisible();
    await openProductPickerAndSelect('自产测试成品乙');
    await input('货物 1 本次完工数量').fill('2');
    await input('货物 1 入库单价').fill('0');
    await expectedLineAmount(0, '0.00');
    await expectedTotal('0.00');
    await input('工单编号或采购单号').fill('PROD-ZERO-BROWSER-20261023-01');
    const zeroPostResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/delivery-notes');
    await buttonContainingText('确认纸箱入库').click();
    const zeroResponse = await zeroPostResponse;
    assert.equal(zeroResponse.status(), 200);
    const zeroNote = db.listDeliveryNotes().find(note => note.work_order_no === 'PROD-ZERO-BROWSER-20261023-01');
    assert.ok(zeroNote);
    assert.equal(zeroNote.total_amount, 0);
    assert.equal(zeroNote.lines[0].amount, 0);
    assert.equal(zeroNote.lines[0].unit_price, 0);
    assert.equal(db.getProduct(finishedProduct.id).stock, baseline.finishedStock + 2, '零价自产仍应增加实收成品库存');
    assert.equal(db.getSupplier(supplier.id).payable, baseline.supplierPayable);
    assert.equal(db.getCustomer(customer.id).debt, baseline.customerDebt);
    assert.deepEqual(db.listLedger({ include_voided: 'true' }).map(entry => ({ ...entry })), baseline.ledger);
    await buttonContainingText('作废整张入库单').click();
    const zeroVoidModal = page.locator('.taro-modal__content:visible').last();
    await expect(zeroVoidModal).toBeVisible();
    await zeroVoidModal.locator('.taro-model__confirm').click();
    await expect.poll(() => apiRequests.some(item => item.method === 'DELETE' && item.path === `/delivery-notes/${zeroNote.id}`)).toBe(true);
    await expect.poll(() => db.getDeliveryNote(zeroNote.id).voided_at).toBeGreaterThan(0);
    assert.equal(db.getProduct(finishedProduct.id).stock, baseline.finishedStock);
    assert.deepEqual(db.listLedger({ include_voided: 'true' }).map(entry => ({ ...entry })), baseline.ledger);

    // The common path needs no details expansion: choose a complete existing
    // SKU, enter the received count, then save the stock-only receipt.
    await page.goto(`${origin}${productionPath}`);
    await expect(input('货物 1 本次完工数量')).toBeVisible();
    await chooseQuickReceipt(page, cartonProduct.name, { kind: 'product' });
    await expect(page.getByTestId('inbound-selected-summary-1')).toContainText(cartonProduct.specification);
    await expect(input('货物 1 入库单价')).toBeHidden();
    await expect(page.getByRole('button', { name: '创建并关联商品', exact: true })).toHaveCount(0);
    await input('货物 1 本次完工数量').fill('2');
    await expectedTotal('5.00');
    await assertNoOverflow(320); await assertNoOverflow(390);
    const quickResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/delivery-notes');
    await buttonContainingText('确认纸箱入库').click();
    const quickResult = await quickResponse;
    assert.equal(quickResult.status(), 200);
    const quickNote = (await quickResult.json()).data;
    assert.equal(quickNote.lines[0].product_id, cartonProduct.id);
    assert.equal(quickNote.lines[0].delivered_qty, 2);
    assert.equal(quickNote.total_amount, 5);
    assert.equal(db.getProduct(cartonProduct.id).stock, baseline.cartonStock + 2);
    assert.equal(db.getSupplier(supplier.id).payable, baseline.supplierPayable);
    assert.equal(db.getCustomer(customer.id).debt, baseline.customerDebt);
    await buttonContainingText('作废整张入库单').click();
    await page.locator('.taro-modal__content:visible').last().locator('.taro-model__confirm').click();
    await expect.poll(() => db.getDeliveryNote(quickNote.id).voided_at).toBeGreaterThan(0);
    assert.equal(db.getProduct(cartonProduct.id).stock, baseline.cartonStock);

    assert.deepEqual(pageErrors, [], '浏览器页面不应产生运行时异常');
    assert.ok(externalBlocked.every(request => !request.includes('youxishen.online')), '拦截的跨域非 API 请求不得触达生产域名');
    console.log(`PASS: quick SKU selection with quantity-only save, production-only carton inbound, auto amount and zero price, multi-line totals, separator, duplicate-click lock, persisted stock-only notes, legacy history separation, void stock rollback, local-only API, 320/390px layouts. Evidence: ${evidence}`);
  } finally {
    await context.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(temporary).startsWith(tempRoot), '临时数据库必须位于操作系统 temp 目录');
    fs.rmSync(temporary, { recursive: true, force: true });
    delete require.cache[require.resolve(dbPath)];
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
