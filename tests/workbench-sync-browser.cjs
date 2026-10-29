const { clickWorkbenchAction } = require('./demo-ui-actions.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');
async function main() {
  const artifacts = path.resolve(process.env.WORKBENCH_SYNC_EVIDENCE_DIR || 'release/business-sync-20261019/evidence'); fs.mkdirSync(artifacts, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(artifacts, 'isolated-data-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('../backend/db');
  const app = express(); app.use(express.json({ limit: '18mb' })); app.use('/api', require('../backend/team')(db));
  app.use(express.static(path.resolve(process.env.WORKBENCH_SYNC_WEB_DIR || process.env.TARO_OUTPUT_DIR || 'release/business-sync-20261019/web')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const contexts = [];
  const errors = [];
  const setup = async width => {
    const context = await browser.newContext({ viewport: { width, height: 900 } }); contexts.push(context);
    await context.addInitScript(() => { if (/^https?:$/.test(location.protocol)) localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true })); });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device' } });
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Warehouse-Revision' } });
      }
      return url.origin === origin ? route.continue() : route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(12000);
    return page;
  };
  const go = async page => { await page.goto('about:blank'); await page.goto(origin + '/#/pages/home/index'); await expect(page.getByText('更多', { exact: true })).toBeVisible(); await expect(page.getByText('● 已同步', { exact: true })).toBeVisible(); };
  const button = (scope, text) => ({ click: () => clickWorkbenchAction(scope, text) });
  const workbench = page => page.getByTestId('simple-workbench');
  try {
    const first = await setup(390), second = await setup(430); await go(first); await go(second);
    assert.equal(await first.getByTestId('workbench-actions').locator('taro-button-core').count(), 4, 'home keeps exactly four main actions');
    await expect(first.getByText('还没有业务记录', { exact: true })).toBeVisible();
    await first.screenshot({ path: path.join(artifacts, 'empty-home.png'), fullPage: true });
    const actor = { id: 'browser-seed', username: '示例操作员' };
    const seed = fn => db.transact(actor, 'browser-change-' + Date.now(), String(Date.now()), String(db.revision()), 'isolated seed', fn).data;
    const supplier = seed(() => db.addSupplier({ name: '学习板厂' }));
    const batch = seed(() => db.receiveBoard({ supplier_id: supplier.id, supplier: supplier.name, date: '2026-10-01', boardLength: 160, boardWidth: 110, cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B', layers: 3, orderedQty: 100, receivedQty: 100, billedArea: 176, unitPrice: 1, deliveryNo: 'SH-1001' }));
    await button(workbench(first), '刷新').click(); await expect(first.getByText('100 张', { exact: true })).toBeVisible();
    await expect(second.getByText('100 张', { exact: true })).toBeVisible({ timeout: 20000 });
    for (const width of [320, 390, 736, 1280]) {
      await first.setViewportSize({ width, height: 900 });
      const root = first.getByTestId('simple-workbench');
      assert.ok(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'no horizontal overflow ' + width);
      await first.screenshot({ path: path.join(artifacts, 'home-' + width + '.png'), fullPage: true });
    }
    await first.setViewportSize({ width: 390, height: 900 });
    await button(workbench(first), '查看库存').click();
    await expect(first.getByTestId('workbench-board')).toContainText('成箱 40 × 30 × 20 cm');
    await button(workbench(first), '生产').click();
    await expect(first.getByLabel('入库纸箱商品', { exact: true })).toContainText('40 × 30 × 20 cm');
    await first.getByLabel('领用纸板数', { exact: true }).fill('10');
    await first.getByLabel('合格纸箱数', { exact: true }).fill('8');
    await button(workbench(first), '确认完工 · 扣纸板并入成品').click();
    await expect.poll(() => db.listProduction().length).toBe(1);
    await expect(first.getByTestId('production-receipt-sheet')).toHaveCount(0);
    assert.equal(db.listBoards()[0].remainingQty, 90); assert.equal(db.listProduction().length, 1);
    const product = db.listProducts()[0]; assert.equal(product.specification, '40 × 30 × 20 cm'); assert.equal(product.stock, 8);
    await button(workbench(second), '查看库存').click();
    await expect(second.getByTestId('workbench-board')).toContainText('90', { timeout: 20000 });
    await go(first);
    await button(workbench(first), '全部记录').click(); await expect(first.getByText('领用 10 张 · 完工 8 个', { exact: true })).toBeVisible();
    await first.screenshot({ path: path.join(artifacts, 'production-record.png'), fullPage: true });
    await button(workbench(first), '票据原件').click(); await button(workbench(first), '学习板厂').click();
    await expect(first.getByRole('dialog', { name: '流水详情' })).toBeVisible();
    await expect(first.getByText('单据凭证', { exact: true })).toBeVisible();
    await first.screenshot({ path: path.join(artifacts, 'receipt-upload.png'), fullPage: true });
    // Upload a real image fixture, then read it through an independent device.
    const fixture = await first.context().newPage();
    await fixture.setContent('<main style="font:24px sans-serif;padding:30px"><h1>学习示例送货单</h1><p>非正式业务凭证</p><p>纸板 160 × 110 cm · 100 张 · 176.00 元</p></main>');
    const bytes = await fixture.screenshot(); await fixture.close();
    await button(first.getByRole('dialog', { name: '流水详情' }), '送货单').click();
    const chooser = first.waitForEvent('filechooser');
    await button(first.getByRole('dialog', { name: '流水详情' }), '添加送货单照片').click();
    await (await chooser).setFiles({ name: 'learning-only.png', mimeType: 'image/png', buffer: bytes });
    await button(first.getByRole('dialog', { name: '流水详情' }), '上传 1 张照片').click();
    await expect(first.getByText('已保存 1 张原图，待人工核对', { exact: true })).toBeVisible();
    await go(second);
    await button(workbench(second), '全部记录').click();
    await button(workbench(second), '票据原件').click();
    await expect(second.getByText('1 张原件照片', { exact: true })).toBeVisible({ timeout: 20000 });
    await button(workbench(second), '学习板厂').click();
    await second.getByRole('button', { name: '查看送货单第 1 张' }).click();
    const original = second.getByRole('dialog', { name: '凭证原图' });
    await expect(original).toBeVisible();
    await expect.poll(() => original.locator('img').evaluateAll(imgs => imgs.some(img => img.complete && img.naturalWidth > 0))).toBe(true);
    assert.equal(db.listBoards()[0].remainingQty, 90); assert.equal(db.getProduct(product.id).stock, 8);
    assert.equal(db.listSuppliers()[0].payable, 176); assert.equal(db.listLedger().length, 1);
    assert.equal(db.listLedger()[0].attachments.length, 1);
    await go(first);
    await button(workbench(first), '收付款 / 账单').click();
    await button(workbench(first), '供货商账单').click(); await expect(first.getByText('当前待付款 ¥176.00', { exact: true })).toBeVisible();
    await button(workbench(first), '付款').click(); await first.locator('[aria-label="供货商付款金额"] input').fill('50'); await button(workbench(first), '确认付款').click();
    await expect(first.getByText('当前待付款 ¥126.00', { exact: true })).toBeVisible();
    await go(first); await button(first.getByTestId('workbench-actions'), '生产纸箱并入库').click(); await expect(first.getByRole('dialog', { name: '纸箱入库', exact: true })).toBeVisible();
    await go(first); await button(first.getByTestId('workbench-actions'), '纸板入库').click();
    await first.getByText('选择已有规格', { exact: true }).click();
    await first.getByText('160 × 110 cm · 学习板厂', { exact: true }).click(); await first.getByText('采购纸板尺寸 · 查看 / 调整', { exact: true }).click();
    await expect(first.getByLabel('实际纸板长', { exact: true })).toHaveValue('160'); await expect(first.getByLabel('实际纸板宽', { exact: true })).toHaveValue('110');
    await expect(first.getByLabel('纸箱尺寸：长 × 宽 × 高', { exact: true })).toHaveValue('40×30×20');
    await first.screenshot({ path: path.join(artifacts, 'shared-specifications.png'), fullPage: true });
    assert.equal(db.listBoards().find(b => b.id === batch.id).remainingQty, 90);
    assert.deepEqual(errors, []);
    console.log('PASS: two browser contexts share real backend revisions and uploaded original photos; production and receipt dimension carryover, separate stock, supplier payable, settlements, documents and 320/390/736/1280 layouts.');
  } finally {
    await Promise.all(contexts.map(c => c.close())); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
