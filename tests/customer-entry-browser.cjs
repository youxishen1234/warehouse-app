const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname, '..');
  const webRoot = path.resolve(process.env.CUSTOMER_ENTRY_WEB_DIR || process.env.TARO_OUTPUT_DIR || path.join(root, 'dist'));
  const evidence = path.resolve(process.env.CUSTOMER_ENTRY_EVIDENCE_DIR || path.join(root, 'release/customer-entry-20261026/evidence/customer-entry'));
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `Missing H5 build: ${webRoot}`);
  fs.mkdirSync(evidence, { recursive: true });

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-customer-entry-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(temporary, 'accounts.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  process.env.WAREHOUSE_PRODUCT_IMAGE_DIR = path.join(temporary, 'products');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], orders: [], ledger: [], _meta: {} }));
  fs.writeFileSync(process.env.WAREHOUSE_ACCOUNTS_FILE, JSON.stringify({ users: [{ id: 'test-admin', username: 'isolated-admin', role: 'admin', disabled: false }], events: [] }));

  const db = require(path.join(root, 'backend/db'));
  const app = express();
  app.use(express.json({ limit: '18mb' }));
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device');
    res.set('Access-Control-Expose-Headers', 'X-Warehouse-Revision');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api', require(path.join(root, 'backend/team'))(db));
  app.use(express.static(webRoot));
  app.get('*', (_req, res) => res.sendFile(path.join(webRoot, 'index.html')));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  let context;
  let page;
  try {
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device',
      'access-control-expose-headers': 'X-Warehouse-Revision'
    };
    await context.addInitScript(() => {
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
      }
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) {
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      }
      return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    });

    const input = placeholder => page.locator(`input[placeholder=${JSON.stringify(placeholder)}]:visible`);
    const go = async hash => {
      await page.goto('about:blank');
      await page.goto(origin + '/#' + hash);
      await expect(page.getByTestId('simple-workbench')).toBeVisible();
      await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible();
    };
    const choosePicker = async (label, option) => {
      const picker = page.getByLabel(label).first();
      if (await picker.evaluate(node => node.tagName === 'SELECT')) {
        await picker.selectOption({ label: option });
      } else {
        await picker.click();
        const wheel = page.locator('.weui-picker__group:visible').last();
        await expect(wheel).toBeVisible();
        await expect.poll(async () => {
          const bounds = await wheel.boundingBox();
          return bounds ? Math.round(bounds.y + bounds.height) : 0;
        }).toBe(page.viewportSize().height);
        const row = wheel.locator('.weui-picker__item').filter({ hasText: option }).first();
        await expect(row).toBeVisible();
        const bounds = await row.boundingBox();
        assert.ok(bounds, `Picker option was not rendered: ${option}`);
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.locator('.weui-picker__action:visible').filter({ hasText: '确定' }).click();
        await expect(wheel).not.toBeVisible();
      }
      await expect(picker).toContainText(option);
    };
    const noOverflow = async width => {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth + 1 &&
        document.body.scrollWidth <= innerWidth + 1
      )).toBe(true);
    };
    const editor = () => page.getByTestId('customer-editor');

    const startingCustomerCount = db.listCustomers().length;
    await go('/pages/business-center/index');
    await expect(page.getByTestId('workbench-actions').locator('taro-button-core')).toHaveCount(4);
    for (const width of [320, 390, 1280]) {
      await noOverflow(width);
      await page.screenshot({ path: path.join(evidence, `customer-entry-home-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 900 });

    await page.getByTestId('workbench-add-customer').click();
    await expect(editor()).toBeVisible();
    await editor().getByLabel('公司名称').locator('input').fill('取消客户草稿');
    await editor().getByText('取消', { exact: true }).click();
    await expect(editor()).toHaveCount(0);
    assert.equal(db.listCustomers().length, startingCustomerCount, 'canceling customer creation must not write a customer');

    await page.getByTestId('workbench-add-customer').click();
    await expect(editor()).toBeVisible();
    await editor().getByLabel('公司名称').locator('input').fill('总台新增客户');
    await editor().getByLabel('联系人').locator('input').fill('陈经理');
    await editor().getByLabel('联系电话').locator('input').fill('13800001111');
    await editor().getByText('保存客户', { exact: true }).click();
    await expect(editor()).toHaveCount(0);
    const homeCustomer = db.listCustomers().find(customer => customer.name === '总台新增客户');
    assert.ok(homeCustomer, 'home customer should persist in the shared customer list');
    assert.equal(homeCustomer.contact, '陈经理');
    assert.equal(homeCustomer.phone, '13800001111');
    await expect(page.getByTestId('finance-customer-view')).toBeVisible();
    await expect(page.getByTestId(`customer-bill-${homeCustomer.id}`)).toBeVisible();
    await page.getByLabel('返回总台').click();
    await page.getByTestId('workbench-customer-bills').click();
    await expect(page.getByTestId('finance-customer-view')).toBeVisible();
    await expect(page.getByTestId(`customer-bill-${homeCustomer.id}`)).toBeVisible();

    await page.getByLabel('返回总台').click();
    await page.getByTestId('workbench-customer-orders').click();
    await expect(page.getByTestId('order-stock-flow')).toBeVisible();
    await page.getByText('＋新增订单', { exact: true }).click();
    await input('订单号').fill('CUSTOMER-ENTRY-ORDER-01');
    await input('规格（可选，如 300×200×150mm）').fill('120×80×60mm');
    await input('材质（可选，如五层AB楞）').fill('五层AB楞');
    await choosePicker('订单单位', '个');
    await input('数量').fill('4');
    await input('单价').fill('3.25');
    const deliveryDate = await page.evaluate(() => {
      const date = new Date();
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    });
    await page.getByText('交货日期：未设置', { exact: true }).click();
    await expect(page.locator('.weui-picker__group:visible')).toHaveCount(3);
    await page.locator('.weui-picker__action:visible').filter({ hasText: '确定' }).click();
    await expect(page.getByText(`交货日期：${deliveryDate}`, { exact: true })).toBeVisible();
    await input('备注（可选）').fill('先确认样品后送货');
    await expect(page.getByTestId('order-amount-preview')).toContainText('¥13.00');
    await choosePicker('选择订单客户', homeCustomer.name);
    await expect(page.getByTestId('order-selected-customer')).toContainText(homeCustomer.name);
    await page.screenshot({ path: path.join(evidence, 'order-draft-before-add-customer-390.png'), fullPage: true });

    await page.getByTestId('order-add-customer').click();
    await expect(editor()).toBeVisible();
    await editor().getByLabel('公司名称').locator('input').fill('订单取消客户草稿');
    await editor().getByText('取消', { exact: true }).click();
    await expect(editor()).toHaveCount(0);
    assert.equal(db.listCustomers().length, startingCustomerCount + 1, 'canceling from order entry must not write a customer');
    await expect(input('订单号')).toHaveValue('CUSTOMER-ENTRY-ORDER-01');
    await expect(input('规格（可选，如 300×200×150mm）')).toHaveValue('120×80×60mm');
    await expect(input('材质（可选，如五层AB楞）')).toHaveValue('五层AB楞');
    await expect(input('备注（可选）')).toHaveValue('先确认样品后送货');
    await expect(input('数量')).toHaveValue('4');
    await expect(input('单价')).toHaveValue('3.25');
    await expect(page.getByTestId('order-selected-customer')).toContainText(homeCustomer.name);
    await expect(page.getByText(`交货日期：${deliveryDate}`, { exact: true })).toBeVisible();

    await page.getByTestId('order-add-customer').click();
    await expect(editor()).toBeVisible();
    await editor().getByLabel('公司名称').locator('input').fill('订单中新增客户');
    await editor().getByLabel('联系人').locator('input').fill('王女士');
    await editor().getByLabel('联系电话').locator('input').fill('13900002222');
    await editor().getByText('保存客户', { exact: true }).click();
    await expect(editor()).toHaveCount(0);
    const orderCustomer = db.listCustomers().find(customer => customer.name === '订单中新增客户');
    assert.ok(orderCustomer, 'order customer should persist in the shared customer list');
    assert.equal(orderCustomer.contact, '王女士');
    assert.equal(orderCustomer.phone, '13900002222');
    // Saving publishes a shared refresh. Wait until the remounted order form has
    // completed its reload before asserting auto-selection and retained draft.
    await expect(page.getByTestId('order-customer-picker')).toBeVisible();
    await expect(page.getByTestId('order-selected-customer')).toContainText(orderCustomer.name);
    await choosePicker('选择订单客户', homeCustomer.name);
    await expect(page.getByTestId('order-selected-customer')).toContainText(homeCustomer.name);
    await choosePicker('选择订单客户', orderCustomer.name);
    await expect(page.getByTestId('order-selected-customer')).toContainText(orderCustomer.name);
    await expect(input('订单号')).toHaveValue('CUSTOMER-ENTRY-ORDER-01');
    await expect(input('规格（可选，如 300×200×150mm）')).toHaveValue('120×80×60mm');
    await expect(input('材质（可选，如五层AB楞）')).toHaveValue('五层AB楞');
    await expect(input('备注（可选）')).toHaveValue('先确认样品后送货');
    await expect(input('数量')).toHaveValue('4');
    await expect(input('单价')).toHaveValue('3.25');
    await expect(page.getByText(`交货日期：${deliveryDate}`, { exact: true })).toBeVisible();
    await expect(page.getByText('单位：个', { exact: true })).toBeVisible();
    await expect(page.getByTestId('order-amount-preview')).toContainText('¥13.00');

    await noOverflow(320);
    await page.screenshot({ path: path.join(evidence, 'order-add-customer-320.png'), fullPage: true });
    await noOverflow(390);
    await page.getByText('保存订单', { exact: true }).click();
    await expect(page.getByText('CUSTOMER-ENTRY-ORDER-01 · 订单中新增客户', { exact: true })).toBeVisible();

    const createdOrder = db.listOrders().find(order => order.order_no === 'CUSTOMER-ENTRY-ORDER-01');
    assert.ok(createdOrder, 'order with newly created customer should persist');
    assert.equal(createdOrder.customer_id, orderCustomer.id);
    assert.equal(createdOrder.customer_name, orderCustomer.name);
    assert.equal(createdOrder.specification, '120×80×60mm');
    assert.equal(createdOrder.material, '五层AB楞');
    assert.equal(createdOrder.quantity, 4);
    assert.equal(createdOrder.unit, '个');
    assert.equal(createdOrder.unit_price, 3.25);
    assert.equal(createdOrder.amount, 13);
    assert.equal(createdOrder.delivery_date, deliveryDate);
    assert.equal(createdOrder.remark, '先确认样品后送货');
    assert.equal(db.listCustomers().filter(customer => customer.name === '订单中新增客户').length, 1, 'order save must not create a duplicate customer');
    await noOverflow(1280);
    await page.screenshot({ path: path.join(evidence, 'orders-1280.png'), fullPage: true });

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({
      result: 'PASS customer entry points and order draft preservation',
      customerIds: [homeCustomer.id, orderCustomer.id],
      order: { id: createdOrder.id, customer_id: createdOrder.customer_id, amount: createdOrder.amount },
      widths: [320, 390, 1280],
      pageErrors: errors,
      evidence
    }, null, 2));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(evidence, 'customer-entry-failure.png'), fullPage: true }).catch(() => {});
      fs.writeFileSync(path.join(evidence, 'customer-entry-failure.html'), await page.content().catch(() => ''), 'utf8');
    }
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
