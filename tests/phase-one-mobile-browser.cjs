const { clickWorkbenchAction } = require('./demo-ui-actions.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const webRoot = path.resolve(process.env.PHASE_ONE_WEB_DIR || process.env.TARO_OUTPUT_DIR || 'release/phase-one-20261028/web');
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `Missing H5 build: ${webRoot}`);
  const evidence = path.resolve(process.env.PHASE_ONE_EVIDENCE_DIR || 'release/phase-one-20261028/mobile-evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-phase-one-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(temporary, 'accounts.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], orders: [], ledger: [], _meta: {} }));
  fs.writeFileSync(process.env.WAREHOUSE_ACCOUNTS_FILE, JSON.stringify({ users: [{ id: 'test-admin', username: 'isolated-admin', role: 'admin', disabled: false }], events: [] }));

  const db = require('../backend/db');
  const cartonGood = { id: 'carton-complete', goods: '单款纸箱', specification: '40×30×20 cm', material: 'B楞', unit: '个', price: 2.5, category: '纸箱', kind: '成品' };
  const purchaseGood = { id: 'purchase-complete', goods: '采购纸箱', specification: '50×40×30 cm', material: 'AB楞', unit: '个', price: 4.2, category: '纸箱', kind: '成品' };
  const boardGood = { id: 'board-complete', goods: '常用纸板', specification: '160×110 cm', material: '牛卡', unit: '张', price: 1.8, unitPrice: 1.8, category: '纸板', kind: '纸板', boardLength: 160, boardWidth: 110, cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'BC', layers: 5 };
  const customer = db.addCustomer({ name: '单款客户', contact: '张经理', phone: '13810001000', debt: 11, specs: [cartonGood] });
  const multiCustomer = db.addCustomer({ name: '多款客户', contact: '李经理', specs: [{ id: 'name-only', goods: '仅名称货物', category: '纸箱', kind: '成品', price: null }, { ...cartonGood, id: 'multi-complete' }] });
  const supplier = db.addSupplier({ name: '常用板厂', contact: '王厂长', phone: '13910002000', payable: 12, specs: [purchaseGood, boardGood] });
  const product = db.addProduct({ name: cartonGood.goods, category: '纸箱', specification: cartonGood.specification, material: cartonGood.material, unit: cartonGood.unit, price: 9, stock: 10, safety_stock: 20 });
  const purchaseProduct = db.addProduct({ name: purchaseGood.goods, category: '纸箱', specification: purchaseGood.specification, material: purchaseGood.material, unit: purchaseGood.unit, price: 8, stock: 4 });
  const localDay = offset => { const date = new Date(); date.setDate(date.getDate() + offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
  for (const [offset, number] of [[-1, 'OVERDUE'], [1, 'UPCOMING']]) db.addOrder({ order_no: number, customer_id: customer.id, customer_name: customer.name, specification: cartonGood.specification, material: cartonGood.material, quantity: 2, unit: '个', unit_price: 2.5, amount: 5, delivery_date: localDay(offset), status: '待发货' });
  const app = express(); app.use(express.json({ limit: '18mb' })); app.use('/api', require('../backend/team')(db)); app.use(express.static(webRoot));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const contexts = []; const errors = []; let failedPath = '';
  const setup = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' }); contexts.push(context);
    await context.addInitScript(() => { if (/^https?:$/.test(location.protocol)) localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true })); });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device', 'access-control-expose-headers': 'X-Warehouse-Revision' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (failedPath && url.pathname.endsWith(failedPath)) return route.fulfill({ status: 503, headers: cors, contentType: 'application/json', body: JSON.stringify({ success: false, error: '隔离弱网验证' }) });
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      }
      return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); return page;
  };
  const page = await setup();
  const input = label => page.getByLabel(label, { exact: true }).locator('xpath=self::input | .//input');
  const click = (label, scope = page) => clickWorkbenchAction(scope, label);
  const go = async route => { await page.goto('about:blank'); await page.goto(origin + '/#' + route); };
  const selectParty = async (type, id) => {
    await page.getByLabel(type === 'customer' ? '关联客户' : '供货商', { exact: true }).selectOption(String(id));
  };
  const openGoods = async (index = 1) => {
    const details = page.getByTestId(`inbound-line-${index}`).locator('details');
    if (!(await details.evaluate(element => element.hasAttribute('open')))) await details.locator('summary').click();
  };
  const chooseGoods = async (name, index = 1) => {
    const picker = page.getByTestId(`inbound-line-${index}`).locator('.quick-spec-picker');
    await picker.locator('.quick-spec-trigger').click();
    await picker.locator('.quick-spec-options button').filter({ hasText: name }).first().click();
  };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile screen has no horizontal overflow');
  try {
    await go('/pages/home/index'); await expect(page.getByTestId('workbench-sync-status')).toContainText('已同步');
    await expect(page.getByTestId('workbench-tasks').locator('taro-button-core')).toHaveCount(1);
    await expect(page.getByTestId('workbench-actions').locator('taro-button-core')).toHaveCount(4);
    await expect(page.getByTestId('workbench-factory-flow')).toHaveCount(0);
    const homeGeometry = await page.evaluate(() => {
      const rect = id => { const r = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left }; };
      return { tasks: rect('workbench-tasks'), summary: rect('workbench-summary'), actions: rect('workbench-actions'), dock: document.querySelector('taro-tabbar').getBoundingClientRect().top, cards: [...document.querySelectorAll('[data-testid="workbench-actions"] > taro-button-core')].map(el => ({ left: el.getBoundingClientRect().left, top: el.getBoundingClientRect().top })) };
    });
    assert.ok(homeGeometry.tasks.top < homeGeometry.summary.top && homeGeometry.summary.top < homeGeometry.actions.top, JSON.stringify(homeGeometry));
    await expect(page.getByTestId('workbench-business-flow')).toContainText('客户下单');
    await expect(page.getByTestId('workbench-business-flow')).toContainText('客户出库');
    await page.getByTestId('workbench-actions').scrollIntoViewIfNeeded();
    assert.ok(await page.getByTestId('workbench-actions').isVisible(), 'all four shortcuts remain reachable below the business workflow');
    assert.ok(homeGeometry.cards[0].left < homeGeometry.cards[1].left && Math.abs(homeGeometry.cards[0].top - homeGeometry.cards[1].top) < 2, 'phone shortcuts use a two-by-two grid');
    await noOverflow(); await page.screenshot({ path: path.join(evidence, 'home-390.png'), fullPage: true });
    await click('库存预警', page.getByTestId('workbench-summary')); await expect(page.getByText('库存预警 · 全部商品', { exact: true })).toBeVisible();
    await go('/pages/home/index'); await click('新增订单', page.getByTestId('workbench-actions')); await expect(page.getByTestId('order-stock-flow')).toBeVisible(); await expect(page.getByRole('spinbutton', { name: '订单数量', exact: true })).toBeVisible();

    for (const type of ['customer', 'supplier']) {
      await go(`/pages/management/index?section=finance&view=${type}`); await expect(page.getByTestId('finance-center')).toBeVisible(); await page.getByTestId(`finance-add-${type}`).click(); await expect(page.getByTestId(`${type}-center`)).toBeVisible(); await expect(page.getByTestId('customer-editor')).toHaveCount(0);
    }

    // Both management pages retain and edit intentionally incomplete goods.
    for (const [type, id, route] of [['customer', multiCustomer.id, '/pages/customers/index'], ['supplier', supplier.id, '/pages/management/index?section=suppliers']]) {
      await go(route); await expect(page.getByTestId(`${type}-center`)).toBeVisible(); await page.getByTestId(`${type}-management-card-${id}`).click();
      await page.getByTestId(`${type}-spec-add-${id}`).click(); const editor = page.getByTestId('customer-quote-editor');
      await page.getByTestId('customer-quote-save').click(); await expect(editor.getByRole('alert')).toContainText('至少填写一项');
      await editor.getByLabel('规格货物', { exact: true }).locator('xpath=self::input | .//input').fill(`${type}仅货名`); await page.getByTestId('customer-quote-save').click(); await expect(editor).toHaveCount(0);
      const saved = (type === 'customer' ? db.getCustomer(id) : db.getSupplier(id)).specs.find(spec => spec.goods === `${type}仅货名`); assert.ok(saved); assert.equal(saved.price, null); assert.equal(saved.unit, '');
      const card = page.getByTestId(type === 'customer' ? `customer-spec-${id}-quote:${id}:${saved.id}` : `party-good-${saved.id}`); await expect(card).toContainText(`${type}仅货名`); await expect(card).toContainText('未记录');
      await card.getByText('编辑', { exact: true }).click(); await expect(editor.getByLabel('规格货物', { exact: true }).locator('xpath=self::input | .//input')).toHaveValue(`${type}仅货名`); await editor.getByLabel('规格材质', { exact: true }).locator('xpath=self::input | .//input').fill('后续补材质'); await page.getByTestId('customer-quote-save').click(); await expect(editor).toHaveCount(0);
      assert.equal((type === 'customer' ? db.getCustomer(id) : db.getSupplier(id)).specs.find(spec => spec.id === saved.id).material, '后续补材质'); await noOverflow();
    }

    await go('/pages/carton-inbound/index'); await selectParty('customer', customer.id, '张经理');
    await openGoods(); await expect(input('货物 1 纸箱名称（必填）')).toHaveValue(cartonGood.goods); await expect(input('货物 1 规格尺寸')).toHaveValue(cartonGood.specification); await expect(input('货物 1 入库单价')).toHaveValue('2.5');
    await input('货物 1 本次完工数量').fill('3'); await expect(page.getByTestId('inbound-line-amount-1')).toContainText('¥7.50'); await click('确认纸箱入库');
    await expect.poll(() => db.getProduct(product.id).stock).toBe(13); assert.equal(db.listProducts().length, 2, 'matching complete goods reuse the existing product');
    const produced = db.listDeliveryNotes().find(note => note.source_type === 'production'); assert.equal(produced.total_amount, 7.5); assert.equal(produced.customer_id, customer.id);

    await go('/pages/carton-inbound/index'); await selectParty('customer', multiCustomer.id, '多款');
    await openGoods();
    await expect(input('货物 1 纸箱名称（必填）')).toHaveValue(''); await expect(page.getByLabel('常用货物', { exact: true })).toContainText('仅名称货物'); await expect(page.getByLabel('常用货物', { exact: true })).toContainText(cartonGood.goods);
    await page.getByLabel('常用货物', { exact: true }).selectOption('name-only'); await expect(input('货物 1 纸箱名称（必填）')).toHaveValue('仅名称货物'); await expect(input('货物 1 规格尺寸')).toHaveValue(''); await expect(input('货物 1 入库单价')).toHaveValue(''); await input('货物 1 本次完工数量').fill('4');
    await expect(page.getByTestId('inbound-line-amount-1')).toContainText('金额未记录'); await expect(page.getByTestId('inbound-total-amount')).toContainText('金额未记录');
    assert.equal(db.listProducts().length, 2, 'incomplete goods do not silently create inventory');
    await click('＋ 再添加一项'); await expect(page.getByLabel('关联客户', { exact: true })).toHaveValue(String(multiCustomer.id)); await chooseGoods(cartonGood.goods, 2); await expect(input('货物 2 纸箱名称（必填）')).toHaveValue(cartonGood.goods); await input('货物 2 本次完工数量').fill('2'); await expect(page.getByTestId('inbound-total-amount')).toContainText('¥5.00'); await page.getByLabel('移除货物 1', { exact: true }).click(); await expect(page.getByTestId('inbound-line-2')).toHaveCount(0);
    await page.screenshot({ path: path.join(evidence, 'carton-multi-390.png'), fullPage: true });

    await go('/pages/carton-inbound/index?kind=purchase'); await selectParty('supplier', supplier.id, '采购纸箱'); await chooseGoods(purchaseGood.goods); await expect(input('货物 1 入库单价')).toHaveValue('4.2'); await expect(input('货物 1 规格尺寸')).toHaveValue(purchaseGood.specification); await input('货物 1 本次完工数量').fill('3'); await expect(page.getByTestId('inbound-total-amount')).toContainText('¥12.60'); await click('确认入库');
    await expect.poll(() => db.getProduct(purchaseProduct.id).stock).toBe(7); const purchased = db.listDeliveryNotes().find(note => note.source_type !== 'production'); assert.equal(purchased.total_amount, 12.6); assert.equal(purchased.supplier_id, supplier.id); assert.equal(db.getSupplier(supplier.id).payable, 24.6);
    await page.screenshot({ path: path.join(evidence, 'purchase-390.png'), fullPage: true });

    const payableBeforeUnlinked = db.getSupplier(supplier.id).payable;
    await go('/pages/carton-inbound/index?kind=purchase'); await expect(page.getByLabel('供货商', { exact: true })).toBeEnabled();
    await openGoods(); await page.getByLabel('货物 1 选择已有商品', { exact: true }).selectOption(String(purchaseProduct.id)); await openGoods(); await input('货物 1 本次完工数量').fill('2'); await input('货物 1 入库单价').fill('1.5'); await click('确认入库');
    await expect.poll(() => db.getProduct(purchaseProduct.id).stock).toBe(9); assert.equal(db.getSupplier(supplier.id).payable, payableBeforeUnlinked, 'unassociated purchasing changes stock without adding supplier payable'); const unlinked = db.listDeliveryNotes().find(note => note.supplier_id == null && note.source_type !== 'production'); assert.ok(unlinked); assert.equal(unlinked.total_amount, 3);

    await go('/pages/board-inbound/index'); await selectParty('supplier', supplier.id, '常用纸板'); await page.getByRole('button', { name: '点击选择常用规格', exact: true }).click(); await page.getByRole('button', { name: /常用纸板 · 40\s*×\s*30\s*×\s*20 cm.*供货商常购 · 常用板厂/ }).click();
    await page.getByText('新增 / 修改规格', { exact: true }).click(); await page.getByText('采购纸板尺寸 · 查看 / 调整', { exact: true }).click(); await expect(input('实际纸板长')).toHaveValue('160'); await expect(input('实际纸板宽')).toHaveValue('110'); await expect(input('纸箱尺寸：长 × 宽 × 高')).toHaveValue('40×30×20'); await expect(input('每平米单价')).toHaveValue('1.8'); await expect(input('实收数')).toHaveValue('');
    await page.getByText('更多信息', { exact: true }).click(); await expect(input('本次运费')).toHaveValue(''); await expect(input('订购数')).toHaveValue(''); await expect(page.getByLabel('入库日期时间', { exact: true })).toHaveValue(new RegExp('^' + localDay(0) + 'T'));
    await input('实收数').fill('10'); await input('计费平米').fill('17.6'); await input('本次运费').fill('6'); await click('再添加一项'); await expect(page.getByLabel('供货商', { exact: true })).toHaveValue(String(supplier.id)); await expect(input('实收数')).toHaveValue(''); await expect(input('本次运费')).toHaveValue('');
    await page.getByRole('button', { name: '点击选择常用规格', exact: true }).click(); await page.getByRole('button', { name: /常用纸板 · 40\s*×\s*30\s*×\s*20 cm.*供货商常购 · 常用板厂/ }).click(); await input('实收数').fill('5'); await input('计费平米').fill('8.8'); await click('确认纸板入库');
    await expect.poll(() => db.listBoards().length).toBe(2); assert.deepEqual(db.listBoards().map(row => row.receivedQty).sort((a, b) => a - b), [5, 10]); assert.equal(db.listBoards().reduce((sum, row) => sum + row.freight, 0), 6); assert.equal(db.listBoards()[0].supplier_id, supplier.id);
    await page.screenshot({ path: path.join(evidence, 'board-390.png'), fullPage: true });

    // A failed statistics endpoint or activity endpoint cannot blank the workbench.
    for (const endpoint of ['/stats', '/ledger']) {
      failedPath = endpoint; const weak = await setup(); await weak.goto(origin + '/#/pages/home/index'); await expect(weak.getByTestId('workbench-actions').locator('taro-button-core')).toHaveCount(4); await expect(weak.getByTestId('workbench-tasks')).toBeVisible(); await expect(weak.getByRole('alert').filter({ hasText: '加载失败' }).first()).toBeVisible(); await expect(weak.getByTestId('workbench-summary')).toBeVisible(); await weak.screenshot({ path: path.join(evidence, `weak-${endpoint.slice(1)}-390.png`), fullPage: true }); await weak.close();
    }
    failedPath = ''; assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log('PASS phase one mobile: search sheets, editable name-only goods, blank-price amounts, automatic carton/product matching, supplier purchase prices, multiple lines, board specification-only carryover, compact dashboard and independent failures.');
  } finally {
    await Promise.all(contexts.map(context => context.close())); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
