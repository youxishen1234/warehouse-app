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
    browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
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

    const go = async hash => {
      await page.goto('about:blank');
      await page.goto(origin + '/#' + hash);
      await expect(page.getByTestId('simple-workbench')).toBeVisible();
      await expect(page.getByText('● 已同步', { exact: true })).toBeVisible();
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
    await go('/pages/home/index');
    await expect(page.getByTestId('workbench-actions').locator('taro-button-core')).toHaveCount(4);

    const customerToolbar = page.getByTestId('workbench-actions');
    assert.deepEqual(await customerToolbar.locator('taro-button-core').allTextContents(), ['收付款', '客户', '供货商', '更多']);
    for (const width of [320, 390, 1280]) {
      await noOverflow(width);
      await page.screenshot({ path: path.join(evidence, `customer-entry-home-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 900 });

    await page.getByTestId('workbench-customer-management').click();
    await expect(page).toHaveURL(/#\/pages\/customers\/index/);
    await expect(page.getByTestId('customer-center')).toBeVisible();
    await expect(page.getByTestId('finance-center')).toHaveCount(0);
    await expect(page.locator('[data-testid^="finance-tab-"]')).toHaveCount(0);
    const customerCenterAdd = page.getByTestId('customer-center-add');
    await expect(customerCenterAdd).toBeVisible();
    await expect(customerCenterAdd).toHaveCount(1);
    await expect(customerCenterAdd).toBeInViewport();
    await customerCenterAdd.click();
    await expect(editor()).toBeVisible();
    await editor().getByLabel('公司名称').locator('xpath=self::input | .//input').fill('取消客户草稿');
    await editor().getByRole('button', { name: '关闭', exact: true }).click();
    await expect(editor()).toHaveCount(0);
    assert.equal(db.listCustomers().length, startingCustomerCount, 'canceling customer creation must not write a customer');

    await customerCenterAdd.click();
    await expect(editor()).toBeVisible();
    await editor().getByLabel('公司名称').locator('xpath=self::input | .//input').fill('客户入口新增客户');
    await editor().getByLabel('联系人').locator('xpath=self::input | .//input').fill('陈经理');
    await editor().getByLabel('联系电话').locator('xpath=self::input | .//input').fill('13800001111');
    await editor().getByText('保存客户资料', { exact: true }).click();
    await expect(editor()).toHaveCount(0);
    const homeCustomer = db.listCustomers().find(customer => customer.name === '客户入口新增客户');
    assert.ok(homeCustomer, 'customer creation from customer management should persist to the shared list');
    assert.equal(homeCustomer.contact, '陈经理');
    assert.equal(homeCustomer.phone, '13800001111');
    const customerCard = page.getByTestId(`customer-management-card-${homeCustomer.id}`);
    await expect(customerCard).toBeVisible();
    assert.equal(await customerCard.count(), 1);

    await customerCard.click(); await page.getByTestId(`customer-edit-${homeCustomer.id}`).click();
    await expect(editor()).toBeVisible();
    await editor().getByLabel('联系人').locator('xpath=self::input | .//input').fill('陈经理（更新）');
    await editor().getByText('保存客户资料', { exact: true }).click();
    await expect(editor()).toHaveCount(0);
    const editedCustomer = db.listCustomers().find(customer => customer.id === homeCustomer.id);
    assert.equal(editedCustomer.contact, '陈经理（更新）');
    assert.equal(db.listCustomers().filter(customer => customer.name === homeCustomer.name).length, 1, 'editing an existing customer must not create a duplicate');
    await page.getByText('‹ 全部客户', { exact: true }).click();
    const responsiveLayouts = [];
    for (const width of [320, 390, 768, 1280, 1920]) {
      await noOverflow(width);
      await expect(customerCenterAdd).toBeInViewport();
      assert.equal(await customerCenterAdd.evaluate(addButton => {
        const firstCustomer = document.querySelector('[data-testid^="customer-management-card-"]');
        return !!firstCustomer && addButton.getBoundingClientRect().bottom <= firstCustomer.getBoundingClientRect().top;
      }), true, 'customer creation stays above the populated customer list');

      const geometry = await page.getByTestId('customer-center').boundingBox();
      assert.ok(geometry.width > 0 && geometry.width <= Math.min(width, 430), 'customer layout follows the demo phone width');
      responsiveLayouts.push({ width, contentWidth: geometry.width });
      await page.screenshot({ path: path.join(evidence, `customer-management-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 900 });

    await page.getByLabel('返回总台').click();
    await expect(page).toHaveURL(/#\/pages\/home\/index/);
    await page.getByTestId('workbench-customer-management').click();
    await expect(page.getByTestId('customer-center')).toBeVisible();
    await page.getByTestId(`customer-management-card-${homeCustomer.id}`).click(); await page.getByTestId('customer-center-orders').click();
    await expect(page.getByTestId('customer-order-sheet')).toBeVisible();
    await expect(page.getByRole('heading', { name: `给${homeCustomer.name}开单` })).toBeVisible();
    await page.getByLabel('订单规格', { exact: true }).fill('120×80×60mm');
    await page.getByLabel('订单材质', { exact: true }).fill('五层AB楞');
    await page.getByLabel('订单单位', { exact: true }).selectOption('个');
    await page.getByLabel('订单数量', { exact: true }).fill('4');
    await page.getByLabel('订单单价', { exact: true }).fill('3.25');
    const deliveryDate = new Date().toLocaleDateString('en-CA');
    await page.getByLabel('交货日期', { exact: true }).fill(deliveryDate);
    assert.equal(db.listCustomers().length, startingCustomerCount + 1);
    await noOverflow(320);
    await page.screenshot({ path: path.join(evidence, 'order-create-320.png'), fullPage: true });
    await noOverflow(390);
    await page.getByRole('button', { name: '保存订单 · 自动检查库存' }).click();
    await expect.poll(() => db.listOrders().filter(order => order.customer_id === homeCustomer.id).length).toBe(1);
    const createdOrder = db.listOrders().find(order => order.customer_id === homeCustomer.id);
    assert.ok(createdOrder, 'order for an existing customer should persist');
    assert.equal(createdOrder.customer_id, homeCustomer.id);
    assert.equal(createdOrder.customer_name, homeCustomer.name);
    assert.equal(createdOrder.specification, '120×80×60mm');
    assert.equal(createdOrder.material, '五层AB楞');
    assert.equal(createdOrder.quantity, 4);
    assert.equal(createdOrder.unit, '个');
    assert.equal(createdOrder.unit_price, 3.25);
    assert.equal(createdOrder.amount, 13);
    assert.equal(createdOrder.delivery_date, deliveryDate);
    assert.equal(createdOrder.remark, '');
    assert.equal(db.listCustomers().length, startingCustomerCount + 1, 'order save must not change the customer list');
    await noOverflow(1280);
    await page.screenshot({ path: path.join(evidence, 'orders-1280.png'), fullPage: true });

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({
      result: 'PASS single customer entry and order customer selection',
      customerIds: [homeCustomer.id],
      order: { id: createdOrder.id, customer_id: createdOrder.customer_id, amount: createdOrder.amount },
      widths: [320, 390, 1280],
      responsiveLayouts,
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
