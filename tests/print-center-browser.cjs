const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-delivery-browser-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.PRINT_WEB_DIR || 'release/print-center-01a1211e/web');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('../backend/db');
  const app = process.env.PRINT_SOURCE_PREVIEW === '1' ? require('./helpers/print-center-source.cjs')(db) : require('../backend/server');
  const customer = db.addCustomer({ name: '华兴包装（演示）', contact: '王先生', phone: '13800000000', address: '河北省沧州市东光县工业园', specs: [{ id: 'spec-demo', goods: '五层瓦楞纸箱', specification: '400x300*200mm', material: '五层', unit: '箱', price: 3.5 }] });
  db.addCustomer({ name: '宏远纸业（演示）', contact: '李女士', phone: '13900000000', address: '东光县开发区' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const engine = process.env.PRINT_BROWSER || 'chromium';
  const browser = await (engine === 'webkit' ? webkit : chromium).launch();
  const artifacts = path.resolve(process.env.PRINT_ARTIFACTS || 'release/print-center-01a1211e/check', engine);
  fs.mkdirSync(artifacts, { recursive: true });
  const errors = [];
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    let failSave = false, failHistory = false, holdCustomer = false, releaseCustomer;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin || !/^https?:$/.test(url.protocol)) return route.continue();
      if (!url.pathname.startsWith('/api/')) return route.abort();
      if (failSave && url.pathname.startsWith('/api/print-notes') && request.method() !== 'GET') {
        failSave = false; return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试保存失败，内容已保留' }) });
      }
      if (failHistory && url.pathname === '/api/print-notes' && request.method() === 'GET') {
        failHistory = false; return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试历史加载失败' }) });
      }
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      if (holdCustomer && url.pathname === '/api/customers' && url.searchParams.get('keyword') === '华兴') {
        holdCustomer = false; await new Promise(resolve => { releaseCustomer = resolve; });
      }
      return route.fulfill({ response });
    });
    page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    const active = () => page.locator('.taro_page:visible').last();
    const button = name => page.getByRole('button', { name, exact: true });
    const noOverflow = async () => {
      assert.equal(await active().evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'mobile page must not overflow horizontally');
      assert.equal(await active().locator('input:visible,select:visible').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().right > innerWidth + 1 || element.getBoundingClientRect().left < -1).length), 0, 'fields fit viewport');
    };
    await page.goto(origin + '/#/pages/print-center/index');
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await button('搜索客户').click();
    await page.getByLabel('搜索客户名称或电话').fill('13800000000');
    await page.getByRole('button', { name: /华兴包装（演示）/ }).click();
    await expect(page.getByLabel('收货单位', { exact: true })).toHaveValue(customer.name);
    await expect(page.getByLabel('收货地址', { exact: true })).toHaveValue(customer.address);
    await expect(page.getByLabel('收货人', { exact: true })).toHaveValue(customer.contact);
    await page.getByLabel('选择客户常用规格').selectOption('spec-demo');
    await expect(page.getByLabel('第1项规格尺寸')).toHaveValue('400×300×200');
    await page.getByLabel('第1项数量').fill('100');
    await page.getByLabel('送货人', { exact: true }).fill('张师傅');
    await page.getByLabel('第1项备注').fill('请轻拿轻放');
    await noOverflow();
    await page.screenshot({ path: path.join(artifacts, 'mobile-editor.png'), fullPage: true });
    await button('保存单据').click();
    await expect.poll(() => db.listPrintNotes().length).toBe(1);
    await expect(button('已保存')).toBeDisabled();
    let saved = db.listPrintNotes()[0]; assert.equal(saved.total, 350);
    await button('历史单据').click();
    await page.getByLabel('搜索历史单据').fill('华兴');
    await page.getByRole('button', { name: /查看详情/ }).click();
    await expect(page.getByRole('heading', { name: '单据详情' })).toBeVisible();
    await noOverflow();
    await page.screenshot({ path: path.join(artifacts, 'mobile-detail.png'), fullPage: true });
    await button('编辑单据').click();
    await page.getByLabel('第1项数量').fill('120');
    await button('保存单据').click();
    await expect.poll(() => db.listPrintNotes()[0].total).toBe(420);
    assert.equal(db.listPrintNotes().length, 1); assert.equal(db.listPrintNotes()[0].number, saved.number);
    await page.reload();
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await button('历史单据').click(); await page.getByRole('button', { name: /查看详情/ }).click();
    await expect(page.getByText('400×300×200 · 120 个 × ¥ 3.5')).toBeVisible();
    await button('编辑单据').click(); await page.getByLabel('第1项备注').fill('保存失败也保留');
    failSave = true; await button('保存单据').click();
    await expect(page.getByRole('alert')).toHaveText('测试保存失败，内容已保留');
    await expect(page.getByLabel('第1项备注')).toHaveValue('保存失败也保留');
    await button('保存单据').click(); await expect(button('已保存')).toBeDisabled();
    await button('搜索客户').click(); holdCustomer = true;
    await page.getByLabel('搜索客户名称或电话').fill('华兴');
    await expect.poll(() => typeof releaseCustomer).toBe('function');
    await page.getByLabel('搜索客户名称或电话').fill('宏远');
    await page.getByRole('button', { name: /宏远纸业/ }).waitFor(); releaseCustomer();
    await expect(page.getByRole('button', { name: /华兴包装（演示）/ })).toHaveCount(0);
    await button('关闭').click();
    await page.getByLabel('第1项数量').fill('125');
    await button('＋ 新建').click(); await expect(page.getByRole('dialog', { name: '保留未保存内容' })).toBeVisible();
    await button('继续编辑').click(); await expect(page.getByLabel('第1项数量')).toHaveValue('125');
    await page.getByLabel('第1项数量').fill('120');
    await button('保存单据').click(); await expect(button('已保存')).toBeDisabled();
    await button('预览打印').click();
    await expect(button('打印送货单')).toBeEnabled();
    const frame = () => page.frameLocator('iframe[title="送货单纸张预览"]');
    await expect(frame().getByRole('heading', { name: '送 货 单' })).toBeVisible();
    await expect(frame().getByText('400×300×200')).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'mobile-preview.png'), fullPage: true });
    for (const paper of ['241-93', '241-140', 'a4']) {
      await page.getByLabel('预览纸张').selectOption(paper); await expect(button('打印送货单')).toBeEnabled();
      await page.evaluate(() => { window.__printCalls = 0; window.print = () => window.__printCalls++; });
      await button('打印送货单').click(); assert.equal(await page.evaluate(() => window.__printCalls), 1);
      await expect(page.locator('[data-dot-matrix-print-root]')).toHaveCount(1);
      assert.equal(await page.locator('[data-dot-matrix-print-root] tr[data-line]').count(), 1);
      if (engine === 'chromium') {
        const pdf = await page.pdf({ path: path.join(artifacts, 'delivery-' + paper + '.pdf'), preferCSSPageSize: true, printBackground: false });
        assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1);
      }
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      await expect(page.locator('[data-dot-matrix-print-root]')).toHaveCount(0);
    }
    await button('返回单据').click();
    for (const width of [320, 375, 430, 1280]) { await page.setViewportSize({ width, height: 900 }); await noOverflow(); }
    await page.screenshot({ path: path.join(artifacts, 'desktop-editor.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    saved = db.listPrintNotes()[0];
    const multi = db.savePrintNote({ ...saved, customer_name: '多页送货客户', items: Array.from({ length: 12 }, (_, index) => ({ ...saved.items[0], name: '纸箱 ' + (index + 1), remark: '多页测试', quantity: 10, price: 1.23456 })) });
    failHistory = true; await button('历史单据').click();
    await expect(page.getByRole('alert')).toContainText('测试历史加载失败');
    await button('重试').click(); await page.getByRole('button', { name: /多页送货客户/ }).click();
    await button('预览打印').click(); await expect(button('打印送货单')).toBeEnabled();
    await expect(frame().locator('tr[data-line]')).toHaveCount(12);
    await expect(frame().locator('.sheet')).toHaveCount(3);
    await button('打印送货单').click();
    assert.equal(await page.locator('[data-dot-matrix-print-root] tr[data-line]').count(), 12);
    if (engine === 'chromium') {
      const pdf = await page.pdf({ path: path.join(artifacts, 'delivery-multipage.pdf'), preferCSSPageSize: true });
      assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 3);
    }
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint'))); await button('返回单据').click();
    await button('编辑单据').click(); await page.getByLabel('第1项备注').fill('我的待保存修改');
    db.savePrintNote({ ...multi, sender: '另一个设备' }, multi.id);
    await button('保存单据').click(); await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('第1项备注')).toHaveValue('我的待保存修改');
    assert.equal(db.listPrintNotes().find(note => note.id === multi.id).sender, '另一个设备');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine, savedEditReload: 'passed', customersAndStaleSearch: 'passed', saveFailure: 'passed', conflict: 'passed', mobileWidths: [320, 375, 390, 430], printPapers: 3, multipage: 12, screenshots: artifacts }));
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }); console.error((await page.locator('body').innerText()).slice(0, 2200)); }
    throw error;
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
