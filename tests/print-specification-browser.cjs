const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');

// Current source is the default. PRINT_SOURCE_PREVIEW=0 plus PRINT_WEB_DIR tests
// an isolated complete build instead. This script never builds or deploys.
// PRINT_WEB_ORIGIN verifies published assets while API requests stay on the disposable DB.
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-print-spec-browser-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.PRINT_WEB_DIR || 'release/print-spec-20261017-231936/web');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('../backend/db');
  const sourcePreview = process.env.PRINT_SOURCE_PREVIEW !== '0';
  const app = sourcePreview ? require('./helpers/print-center-source.cjs')(db) : require('../backend/server');
  const customer = db.addCustomer({ name: '华兴包装（规格验收）', contact: '王先生', phone: '13800001111', address: '东光县工业园' });
  db.updateCustomer(customer.id, { specs: [
    { id: 'alpha-large', goods: '华兴大箱', specification: '400x300*200mm', material: '五层牛卡', unit: '个', price: 3.5 },
    { id: 'alpha-small', goods: '华兴小箱', specification: '200x150*100mm', material: '三层牛卡', unit: '个', price: 1.75 },
  ] });
  const other = db.addCustomer({ name: '宏远纸业（规格验收）', contact: '李女士', phone: '13900002222' });
  db.updateCustomer(other.id, { specs: [
    { id: 'beta-large', goods: '宏远纸箱', specification: '600x400*300mm', material: '七层瓦楞', unit: '个', price: 7 },
  ] });
  const product = db.addProduct({ name: '库存天地盖', specification: '320x240*160mm', material: '白卡覆膜', unit: '个', price: 4.25, stock: 88 });
  db.addProduct({ name: '不可按个添加的纸板', specification: '900x600mm', material: '纸板专用', unit: '平方米', price: 2, stock: 120 });
  const dimensions = db.getCustomerDimensions();
  db.updateCustomerDimensions({ ...dimensions, customers: [
    { id: 'dim-alpha', name: customer.name, specs: [{ id: 'alpha-cm', goods: '华兴尺寸本', size: '45x30*20', sizeUnit: 'cm', material: '加厚白卡', unit: '个', kind: '成品' }] },
    { id: 'dim-beta', name: other.name, specs: [{ id: 'beta-cm', goods: '宏远尺寸本', size: '60x40*30', sizeUnit: 'cm', material: '高强瓦楞', unit: '个', kind: '成品' }] },
  ] });
  const inventoryBefore = db.listProducts().map(row => ({ id: row.id, stock: row.stock }));
  const transactionsBefore = db.listTx().length;
  const debtBefore = db.getCustomer(customer.id).debt;
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const webOrigin = process.env.PRINT_WEB_ORIGIN ? new URL(process.env.PRINT_WEB_ORIGIN).origin : origin;
  const engine = process.env.PRINT_BROWSER || 'chromium';
  const artifacts = path.resolve(process.env.PRINT_ARTIFACTS || 'release/print-spec-20261017-231936/check', engine);
  fs.mkdirSync(artifacts, { recursive: true });
  const errors = [], checks = [];
  const requests = { products: 0, dimensions: 0 };
  let browser, page, releaseDimensions;
  try {
    browser = await (engine === 'webkit' ? webkit : chromium).launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    let failDimensions = false, holdDimensions = false;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!/^https?:$/.test(url.protocol)) return route.continue();
      if (!url.pathname.startsWith('/api/')) return url.origin === origin || url.origin === webOrigin ? route.continue() : route.abort();
      if (request.method() === 'GET' && url.pathname === '/api/products') requests.products++;
      if (request.method() === 'GET' && url.pathname === '/api/customer-dimensions') {
        requests.dimensions++;
        if (failDimensions) {
          failDimensions = false;
          return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, message: '规格测试加载失败，请重试' }) });
        }
      }
      // All API origins use this disposable DB, including configured public hosts.
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      if (holdDimensions && url.pathname === '/api/customer-dimensions') {
        holdDimensions = false;
        await new Promise(resolve => { releaseDimensions = resolve; });
      }
      return route.fulfill({ response });
    });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    const button = name => page.getByRole('button', { name, exact: true });
    const dialog = () => page.getByRole('dialog', { name: '搜索并添加规格', exact: true });
    const options = () => dialog().getByRole('button', { name: /^添加规格 / });
    const add = (name, specification) => dialog().getByRole('button', { name: `添加规格 ${name} ${specification}`, exact: true });
    const field = (index, name) => page.getByLabel(`第${index}项${name}`, { exact: true });
    const itemNames = () => page.locator('input[aria-label$="项产品名称"]');
    const open = async () => { await button('搜索 / 添加规格').click(); await expect(dialog()).toBeVisible(); };
    const close = async () => { await dialog().getByRole('button', { name: '关闭规格选择', exact: true }).click(); await expect(dialog()).toHaveCount(0); };
    const dismissGettingStarted = async () => {
      await expect(button('搜索 / 添加规格')).toBeVisible();
      const skip = page.getByRole('button', { name: '暂时跳过', exact: true });
      if (await skip.isVisible()) {
        await skip.click();
        await expect(page.getByRole('dialog', { name: '新手使用说明', exact: true })).toBeHidden();
      }
    };
    const selectCustomer = async () => {
      await button('搜索客户').click();
      await page.getByLabel('搜索客户名称或电话').fill('13800001111');
      await page.getByRole('button', { name: /华兴包装（规格验收）/ }).click();
      await expect(page.getByLabel('收货单位', { exact: true })).toHaveValue(customer.name);
      await expect(page.getByLabel('选择客户常用规格')).toBeVisible();
    };
    const newDraft = async () => {
      await button('＋ 新建').click();
      const discard = page.getByRole('dialog', { name: '保留未保存内容' });
      if (await discard.count()) await discard.getByRole('button', { name: '放弃并继续', exact: true }).click();
      await expect(itemNames()).toHaveCount(1);
      await expect(field(1, '产品名称')).toHaveValue('');
      await expect(page.getByLabel('收货单位', { exact: true })).toHaveValue('');
    };
    const noOverflow = async () => {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), { message: 'page fits viewport horizontally' }).toBe(true);
      const active = page.locator('[data-print-view="edit"]');
      await expect.poll(() => active.evaluate(element => element.scrollWidth <= element.clientWidth + 1), { message: 'print center fits viewport horizontally' }).toBe(true);
      if (await dialog().count()) {
        const bounds = await dialog().boundingBox();
        assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= page.viewportSize().width + 1, 'picker fits viewport');
        await expect.poll(() => dialog().evaluate(element => element.scrollWidth <= element.clientWidth + 1), { message: 'picker content fits horizontally' }).toBe(true);
      }
    };
    const inventoryUnchanged = () => {
      assert.deepEqual(db.listProducts().map(row => ({ id: row.id, stock: row.stock })), inventoryBefore);
      assert.equal(db.listTx().length, transactionsBefore);
      assert.equal(db.getCustomer(customer.id).debt, debtBefore);
    };

    await page.goto(webOrigin + '/#/pages/print-center/index');
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '新建送货单', exact: true }).click();
    await dismissGettingStarted();
    await expect(button('搜索 / 添加规格')).toBeVisible();
    assert.deepEqual(requests, { products: 0, dimensions: 0 }, 'catalog loads only when opened');
    await open();
    await expect(add('华兴大箱', '400×300×200')).toBeVisible();
    for (const query of ['400x300*200', '400*300×200', '400×300×200']) {
      await page.getByLabel('搜索规格', { exact: true }).fill(query);
      await expect(options()).toHaveCount(1);
      await expect(add('华兴大箱', '400×300×200')).toBeVisible();
    }
    await page.getByLabel('搜索规格', { exact: true }).fill('加厚白卡');
    await expect(options()).toHaveCount(1);
    await expect(options().first()).toHaveAttribute('aria-label', /华兴尺寸本.*45×30×20.*cm/i);
    await page.getByLabel('搜索规格', { exact: true }).fill('宏远纸业');
    await expect(options()).toHaveCount(2);
    await page.getByLabel('搜索规格', { exact: true }).fill('');
    await expect(add('不可按个添加的纸板', '900×600')).toHaveCount(0);
    await add('库存天地盖', '320×240×160').click();
    await expect(add('库存天地盖', '320×240×160')).toBeDisabled();
    await close();
    await expect(itemNames()).toHaveCount(1);
    await expect(field(1, '产品名称')).toHaveValue('库存天地盖');
    await expect(field(1, '单价')).toHaveValue('4.25');
    await expect(field(1, '数量')).toHaveValue('');
    await expect(field(1, '备注')).toHaveValue(/白卡覆膜/);
    inventoryUnchanged();
    checks.push('lazy load; normalized size, material and customer search; product filtering; single add reuses empty line');

    await newDraft();
    await selectCustomer();
    await open();
    await expect(dialog().getByRole('button', { name: '当前客户', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(options()).toHaveCount(3);
    await expect(add('宏远纸箱', '600×400×300')).toHaveCount(0);
    await expect(add('库存天地盖', '320×240×160')).toHaveCount(0);
    await add('华兴大箱', '400×300×200').click();
    await close();
    await expect(itemNames()).toHaveCount(1);
    await expect(field(1, '规格尺寸')).toHaveValue('400×300×200');
    await expect(field(1, '单价')).toHaveValue('3.5');
    await expect(field(1, '备注')).toHaveValue(/五层牛卡/);
    await expect(field(1, '数量')).toHaveValue('');
    await field(1, '数量').fill('10');
    await button('保存单据').click();
    await expect(button('已保存')).toBeDisabled();
    await expect.poll(() => db.listPrintNotes().length).toBe(1);
    const saved = db.listPrintNotes()[0];
    assert.equal(saved.total, 35);
    assert.equal(saved.items.length, 1);
    await button('预览打印').click();
    await expect(button('打印送货单')).toBeEnabled();
    const frame = () => page.frameLocator('iframe[title="送货单纸张预览"]');
    await expect(frame().getByText('400×300×200', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'single-preview.png'), fullPage: true });
    await button('返回单据').click();
    inventoryUnchanged();
    await page.reload();
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '新建送货单', exact: true }).click();
    await dismissGettingStarted();
    await button('历史单据').click();
    await page.getByRole('button', { name: /查看详情/ }).click();
    await button('编辑单据').click();
    await open();
    await expect(dialog().getByRole('button', { name: '当前客户', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(add('华兴大箱', '400×300×200')).toBeDisabled();
    await expect(add('华兴小箱', '200×150×100')).toBeEnabled();
    await add('华兴小箱', '200×150×100').click();
    await close();
    await expect(itemNames()).toHaveCount(2);
    await field(2, '数量').fill('5');
    await button('保存单据').click();
    await expect(button('已保存')).toBeDisabled();
    assert.equal(db.listPrintNotes().length, 1);
    assert.equal(db.listPrintNotes()[0].number, saved.number);
    assert.equal(db.listPrintNotes()[0].total, 43.75);
    inventoryUnchanged();
    checks.push('current customer isolation; original customer selector retained; save/preview/history edit reuse original flows');

    await newDraft();
    await selectCustomer();
    await open();
    await add('华兴大箱', '400×300×200').click();
    await dialog().getByRole('button', { name: '一键添加全部', exact: true }).click();
    await expect(itemNames()).toHaveCount(3);
    await expect(dialog().getByRole('button', { name: '一键添加全部', exact: true })).toBeDisabled();
    await expect(add('华兴大箱', '400×300×200')).toBeDisabled();
    await close();
    const names = await itemNames().evaluateAll(inputs => inputs.map(input => input.value));
    assert.equal(new Set(names).size, 3, 'batch does not duplicate a previously added specification');
    const dimensionIndex = names.indexOf('华兴尺寸本') + 1;
    assert.ok(dimensionIndex > 0);
    await expect(field(dimensionIndex, '规格尺寸')).toHaveValue(/45×30×20\s*cm/i);
    await expect(field(dimensionIndex, '单价')).toHaveValue('');
    await expect(field(dimensionIndex, '数量')).toHaveValue('');
    await expect(field(dimensionIndex, '备注')).toHaveValue(/加厚白卡/);
    for (let index = 1; index <= 3; index++) await field(index, '数量').fill('2');
    await button('保存单据').click();
    await expect(page.getByRole('alert')).toContainText('单价');
    assert.equal(db.listPrintNotes().length, 1, 'dimension without price must not save as a free item');
    await field(dimensionIndex, '单价').fill('9');
    await button('保存单据').click();
    await expect(button('已保存')).toBeDisabled();
    assert.equal(db.listPrintNotes().length, 2);
    await button('预览打印').click();
    await expect(frame().locator('tr[data-line]')).toHaveCount(3);
    await expect(frame().getByText(/45×30×20\s*cm/i)).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'batch-preview.png'), fullPage: true });
    await button('返回单据').click();
    inventoryUnchanged();
    checks.push('batch dedupe; cm and material preserved; blank quantity/price; explicit missing-price validation');

    for (const [name, value] of [['备注', '原备注必须保留'], ['单价', '6.25']]) {
      await newDraft();
      await selectCustomer();
      await field(1, name).fill(value);
      await open();
      await add('华兴小箱', '200×150×100').click();
      await close();
      await expect(itemNames()).toHaveCount(2);
      await expect(field(1, name)).toHaveValue(value);
      await expect(field(1, '产品名称')).toHaveValue('');
      await expect(field(2, '产品名称')).toHaveValue('华兴小箱');
    }
    await open();
    await dialog().getByRole('button', { name: '全部规格', exact: true }).click();
    await page.getByLabel('搜索规格', { exact: true }).fill('宏远纸业');
    await expect(options()).toHaveCount(2);
    await dialog().getByRole('button', { name: '一键添加搜索结果', exact: true }).click();
    await expect(itemNames()).toHaveCount(4);
    await expect(dialog().getByRole('button', { name: '一键添加搜索结果', exact: true })).toBeDisabled();
    await close();
    checks.push('remark-only and price-only rows preserved; filtered batch adds only matching results once');

    failDimensions = true;
    await open();
    await expect(dialog().getByRole('alert')).toContainText('规格测试加载失败');
    await dialog().getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(add('华兴大箱', '400×300×200')).toBeVisible();
    await expect(dialog().getByRole('alert')).toHaveCount(0);
    await close();
    holdDimensions = true;
    releaseDimensions = undefined;
    await open();
    await expect.poll(() => typeof releaseDimensions).toBe('function');
    await page.getByLabel('搜索规格', { exact: true }).fill('已经关闭的查询');
    await close();
    const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/customer-dimensions');
    releaseDimensions();
    releaseDimensions = undefined;
    await lateResponse;
    await expect(dialog()).toHaveCount(0);
    await open();
    await expect(page.getByLabel('搜索规格', { exact: true })).toHaveValue('');
    await expect(add('华兴大箱', '400×300×200')).toBeVisible();
    await dialog().getByRole('button', { name: '全部规格', exact: true }).click();
    await expect(page.getByText('规格测试加载失败，请重试', { exact: true })).toBeHidden({ timeout: 5000 });
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow();
      await page.screenshot({ path: path.join(artifacts, `picker-${width}.png`), fullPage: true });
    }
    await close();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow();
    }
    await page.screenshot({ path: path.join(artifacts, 'editor-1280.png'), fullPage: true });
    inventoryUnchanged();
    checks.push('load failure retry; closed late response ignored; reopened search resets; 320/390/1280 layouts; no automatic stock movement');
    for (const [changedField, changedValue] of [['产品名称', '自定义天地盖'], ['规格尺寸', '321x241*161']]) {
      await newDraft();
      await selectCustomer();
      await open();
      await dialog().getByRole('button', { name: '全部规格', exact: true }).click();
      await add('库存天地盖', '320×240×160').click();
      await close();
      await field(1, '数量').fill('2');
      await button('保存单据').click();
      await expect(button('已保存')).toBeDisabled();
      let productNote = db.listPrintNotes()[0];
      assert.equal(productNote.items[0].product_id, product.id, 'catalog product retains stock link');
      await field(1, '数量').fill('3');
      await field(1, '单价').fill('5.5');
      await button('保存单据').click();
      await expect(button('已保存')).toBeDisabled();
      productNote = db.listPrintNotes().find(note => note.id === productNote.id);
      assert.equal(productNote.items[0].product_id, product.id, 'quantity and price edits retain stock link');
      await field(1, changedField).fill(changedValue);
      await button('保存单据').click();
      await expect(button('已保存')).toBeDisabled();
      assert.equal(db.listPrintNotes().find(note => note.id === productNote.id).items[0].product_id, null, 'name or size edits detach stock product');
      inventoryUnchanged();
    }
    checks.push('product_id saved and retained for quantity/price edits; cleared for name/size edits');
    await newDraft();
    await page.getByLabel('收货单位', { exact: true }).fill(customer.name);
    await open();
    await expect(dialog().getByRole('button', { name: '当前客户', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(options()).toHaveCount(3);
    await close();
    checks.push('typed customer name also selects current customer scope');
    assert.deepEqual(errors, []);
    const result = { engine, sourcePreview, webOrigin, status: 'passed', checks, savedNotes: db.listPrintNotes().length, inventoryProduct: product.id, requests, screenshots: artifacts };
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
      console.error((await page.locator('body').innerText()).slice(0, 4000));
    }
    throw error;
  } finally {
    if (releaseDimensions) releaseDimensions();
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
