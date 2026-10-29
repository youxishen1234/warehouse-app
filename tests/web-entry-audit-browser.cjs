const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('../backend/node_modules/express');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-web-entries-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(temporary, 'accounts.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('../backend/db');
  const customer = db.addCustomer({ name: '入口核对客户', specs: [{ id: 'audit-carton', goods: '入口纸箱', specification: '30×20×15 cm', material: '牛卡', unit: '个', price: 5, category: '纸箱', kind: '成品' }] });
  const supplier = db.addSupplier({ name: '入口核对板厂' });
  const batch = db.receiveBoard({ supplier_id: supplier.id, supplier: supplier.name, customerName: customer.name, date: new Date().toLocaleDateString('en-CA'), boardLength: 120, boardWidth: 80, cartonLength: 30, cartonWidth: 20, cartonHeight: 15, fluteType: 'B', layers: 3, receivedQty: 100, orderedQty: 100, billedArea: 96, unitPrice: 2 });
  const product = db.addProduct({ name: '入口纸箱', category: '纸箱', specification: '30×20×15 cm', material: '牛卡', unit: '个', price: 5, stock: 30, safety_stock: 40 });
  db.stockOut(product.id, 2, '隔离测试', '', customer.id, { unit_price: 5 });
  db.addOrder({ order_no: 'ENTRY-AUDIT-001', customer_id: customer.id, customer_name: customer.name, specification: product.specification, quantity: 5, unit: '个', unit_price: 5, status: '待发货' });
  const app = express();
  app.use(express.json({ limit: '18mb' })); app.use('/api', require('../backend/team')(db));
  app.use(express.static(path.resolve(process.env.TARO_OUTPUT_DIR || 'release/web-entry-audit-20261028/web')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const apiOrigin = 'http://127.0.0.1:' + server.address().port;
  const origin = process.env.WEB_ENTRY_ORIGIN ? new URL(process.env.WEB_ENTRY_ORIGIN).origin : apiOrigin;
  const evidence = path.resolve(process.env.WEB_ENTRY_EVIDENCE_DIR || 'release/web-entry-audit-20261028/evidence'); fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const errors = [], checked = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    await context.addInitScript(() => { if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true })); });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device', 'access-control-expose-headers': 'X-Warehouse-Revision' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const response = await route.fetch({ url: apiOrigin + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      }
      return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    const active = () => page.locator('.taro_page:visible').last();
    const click = text => active().getByText(text, { exact: true }).last().locator('xpath=ancestor-or-self::*[self::button or self::taro-button-core][1]').click();
    const go = async route => { await page.goto('about:blank'); await page.goto(origin + '/#' + route); };
    const screenshot = async name => {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true });
    };
    for (const [route, marker, modernHeader = true] of [
      ['/pages/home/index', '[data-testid="workbench-business-flow"]'],
      ['/pages/management/index', '[data-panel="stock"]'],
      ['/pages/inventory/index', '[data-panel="stock"]'],
      ['/pages/customers/index', '[data-testid="customer-center"]'],
      ['/pages/management/index?section=suppliers', '[data-testid="supplier-center"]'],
      ['/pages/management/index?section=finance', '[data-testid="finance-center"]'],
      ['/pages/management/index?section=paperboard-receipt', '[data-testid="stock-entry-page"]'],
      ['/pages/management/index?section=receipt&kind=carton', '[data-testid="stock-entry-page"]'],
      ['/pages/management/index?section=receipt', '[data-testid="stock-entry-page"]'],
      ['/pages/management/index?section=shipment', '[data-testid="stock-entry-page"]'],
      ['/pages/management/index?section=paperboard-batch&id=' + batch.id, '.board-detail-row'],
      ['/pages/management/index?section=paperboard-movement&id=' + batch.id, '.board-page'],
      ['/pages/management/index?section=stock-scanner', '.board-page'],
      ['/pages/management/index?section=orders', '.business-page-header'],
      ['/pages/management/index?section=transactions', '.business-page-header'],
      ['/pages/management/index?section=goods', '.business-page-header'],
      ['/pages/print-center/index', '[data-print-view="home"]']
      ,['/pages/management/index?section=dimensions', '.board-page']
      ,['/pages/management/index?section=party-details', '.business-page-header']
      ,['/pages/management/index?section=team', '.business-page-header']
      ,['/pages/management/index?section=backup', '.business-page-header']
      ,['/pages/management/index?section=originals', 'main', false]
      ,['/pages/ai-assistant/index', '[data-ai-assistant]', false]
      ,['/pages/mine/index', 'taro-scroll-view-core', false]
      ,['/pages/management/index?section=labels', 'nav[aria-label="打印类型"]', false]
      ,['/pages/management/index?section=label-lookup&v=1&kind=paperboard-batch&id=' + batch.id, '.label-resolver-page']
    ]) {
      await go(route); await expect(active().locator(marker).first()).toBeVisible();
      if (modernHeader) await expect(active().locator('[data-ui-version="web-workbench-v2"]').first()).toBeVisible();
      await screenshot('route-' + checked.length);
      if (route.includes('workbench') || route === '/pages/home/index' || route.includes('inventory') || route.includes('print-center')) await screenshot(route.includes('print-center') ? 'print' : route.includes('inventory') ? 'stock' : 'home');
      checked.push(route);
    }
    const configuredPages = [...fs.readFileSync('src/app.config.ts', 'utf8').split('window:')[0].matchAll(/'(pages\/[a-z-]+\/index)'/g)].map(match => '/' + match[1]);
    assert.deepEqual(configuredPages.filter(route => !checked.some(checkedRoute => checkedRoute.split('?')[0] === route)), [], 'every configured page has an audited entry');
    for (const legacy of ['print.html', 'customers.html', 'management.html', 'legacy-entry.js']) {
      assert.equal(fs.existsSync(path.join(path.resolve(process.env.TARO_OUTPUT_DIR || 'dist'), legacy)), false, legacy + ' must not be packaged');
      const response = await page.request.get(origin + '/' + legacy);
      assert([404, 410].includes(response.status()), legacy + ' must be retired');
    }
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [name, route] of [['home', '/pages/home/index'], ['stock', '/pages/inventory/index'], ['print', '/pages/print-center/index']]) {
        await go(route); await expect(active().locator('[data-ui-version="web-workbench-v2"]').first()).toBeVisible();
        await screenshot(name + '-' + width);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await go('/pages/home/index'); await expect(page.getByTestId('workbench-sync-status')).toContainText('已同步');
    await click('备货业务'); await expect(page.getByTestId('workbench-business-flow')).toContainText('先备货');
    await screenshot('stock-workflow'); await page.getByTestId('workbench-business-flow').getByText('＋ 纸箱入库', { exact: true }).click();
    await expect(active().getByTestId('stock-entry-page')).toBeVisible(); await active().getByLabel('返回', { exact: true }).click(); await expect(page.getByTestId('workbench-business-flow')).toBeVisible();
    await click('销售业务'); await click('客户出库');
    await expect(active().getByTestId('stock-entry-page')).toBeVisible();
    await go('/pages/print-center/index'); await active().getByRole('button', { name: '选择出库单', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '选择出库单' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button').filter({ hasText: customer.name }).click();
    await expect(active().locator('iframe')).toBeVisible();
    await go('/pages/print-center/index');
    await active().getByRole('button', { name: '临时打印', exact: true }).click();
    await expect(active().getByLabel('收货单位', { exact: true })).toBeVisible();
    await go('/pages/print-center/index');
    await active().getByRole('navigation', { name: '打印类型' }).getByRole('button', { name: '对账单', exact: true }).click();
    await active().getByLabel('选择对账单位').selectOption(String(customer.id)); await active().getByRole('button', { name: '查看大图', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '对账单预览' })).toContainText('¥10.00');
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('heading', { name: '客户对账单', exact: true })).toBeVisible();
    await expect(page.locator('.business-statement-sheet')).toContainText(customer.name);
    await expect(page.locator('.business-statement-toolbar')).toBeHidden();
    await page.screenshot({ path: path.join(evidence, 'statement-print.png'), fullPage: true });
    await page.pdf({ path: path.join(evidence, 'statement.pdf'), format: 'A4', printBackground: true });
    await page.emulateMedia({ media: 'screen' });
    await go('/pages/management/index?section=paperboard-receipt');
    await page.getByLabel('成箱规格尺寸', { exact: true }).locator('input').fill('30×20×15');
    await page.getByLabel('实收数', { exact: true }).locator('input').fill('12');
    await page.getByText('确认入库 · 生成批次标签', { exact: true }).click();
    await expect(active().getByText('待补金额，未生成应付', { exact: true })).toBeVisible();
    assert.equal(db.listBoards().find(row => row.boardDimensionsPending).remainingQty, 12);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, 'routes.json'), JSON.stringify({ checked, errors }, null, 2));
    console.log('PASS: ' + checked.length + ' web routes, workflow navigation and return, automatic/manual printing, real statement and optional board receipt');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
