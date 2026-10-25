const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function main() {
  const webRoot = path.resolve(process.env.WORKBENCH_REFRESH_WEB_DIR || process.env.TARO_OUTPUT_DIR || 'dist');
  assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `H5 构建不存在: ${webRoot}`);
  const artifacts = path.resolve(process.env.WORKBENCH_REFRESH_EVIDENCE_DIR || 'release/workbench-refresh-browser');
  fs.mkdirSync(artifacts, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(artifacts, 'isolated-data-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], orders: [], ledger: [],
    delivery_notes: [], production_records: [], board_batches: [], stocktakes: []
  }));

  const db = require('../backend/db');
  const pad = value => String(value).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  db.receiveBoard({
    supplier: '刷新验收纸板厂', date: today, boardLength: 160, boardWidth: 110,
    cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B',
    layers: 3, orderedQty: 100, receivedQty: 100, billedArea: 176, unitPrice: 1
  });
  const carton = db.addProduct({
    name: '刷新验收纸箱', category: '纸箱', specification: '40×30×20 cm',
    unit: '个', price: 2, stock: 12, safety_stock: 1
  });
  const customer = db.addCustomer({ name: '刷新验收客户' });
  db.stockOut(carton.id, 1, '隔离验收操作员', '隔离账单流水验收', customer.id, { unit_price: 50 });
  db.settleParty('customer', customer.id, 10, '隔离验收收款');

  const app = express();
  app.use(express.json({ limit: '18mb' }));
  app.use('/api', require('../backend/team')(db));
  app.use(express.static(webRoot));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const contexts = [];
  const errors = [];
  const initialProductionGate = { kind: 'initial', started: deferred(), release: deferred() };
  const productionGates = [initialProductionGate];
  let productionBehavior = initialProductionGate;
  let failProductionReads = 0;

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  contexts.push(context);
  await context.addInitScript(() => {
    if (/^https?:$/.test(location.protocol)) {
      localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true }));
    }
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'access-control-allow-headers': 'Content-Type,Authorization,If-Match,Idempotency-Key,X-Warehouse-Device'
          }
        });
      }
      if (url.pathname === '/api/production' && route.request().method() === 'GET') {
        if (failProductionReads > 0) {
          failProductionReads -= 1;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Warehouse-Revision' },
            body: JSON.stringify({ success: false, message: '隔离测试模拟读取失败' })
          });
        }
        if (productionBehavior) {
          const behavior = productionBehavior;
          productionBehavior = null;
          behavior.started.resolve();
          await behavior.release.promise;
        }
      }
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      return route.fulfill({
        response,
        headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Warehouse-Revision' }
      });
    }
    return url.origin === origin ? route.continue() : route.abort();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  const workbench = page.getByTestId('simple-workbench');
  const button = (scope, text) => scope.getByText(text, { exact: true }).last()
    .locator('xpath=ancestor-or-self::*[self::taro-button-core or self::button][1]');
  try {
    await page.goto(origin + '/#/pages/business-center/index');
    await initialProductionGate.started.promise;
    await expect(page.getByTestId('workbench-initial-loading')).toContainText('正在读取业务数据');
    initialProductionGate.release.resolve();
    await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible();
    await expect(page.getByTestId('workbench-today')).toContainText('刷新验收纸板厂 · 纸板入库');

    // On the home panel, keep the actions and activity visible while a manual
    // refresh is waiting for its slow endpoint.
    const homeRefreshGate = { kind: 'home-refresh', started: deferred(), release: deferred() };
    productionGates.push(homeRefreshGate);
    productionBehavior = homeRefreshGate;
    await button(workbench, '刷新').click();
    await homeRefreshGate.started.promise;
    await expect(page.getByTestId('workbench-sync-status')).toContainText('当前数据仍可查看');
    await expect(page.getByTestId('workbench-actions')).toBeVisible();
    await expect(page.getByTestId('workbench-today')).toContainText('刷新验收纸板厂 · 纸板入库');
    await expect(page.getByTestId('workbench-initial-loading')).toHaveCount(0);
    homeRefreshGate.release.resolve();
    await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible();

    // Manual refresh must keep the prior usable snapshot, activity and an
    // unfinished production form mounted while the slow endpoint is pending.
    await button(workbench, '生产').click();
    const consumed = page.getByLabel('领用纸板数').locator('input');
    await consumed.fill('7');
    await consumed.evaluate(element => {
      element.dataset.refreshProbe = 'same-node';
      window.__workbenchRefreshProbe = element;
    });
    const refreshGate = { kind: 'draft-refresh', started: deferred(), release: deferred() };
    productionGates.push(refreshGate);
    productionBehavior = refreshGate;
    await button(workbench, '刷新').click();
    await refreshGate.started.promise;
    await expect(page.getByTestId('workbench-sync-status')).toContainText('当前数据仍可查看');
    await expect(consumed).toBeVisible();
    await expect(page.getByTestId('workbench-initial-loading')).toHaveCount(0);
    const probeDuringRefresh = await page.evaluate(() => {
      const original = window.__workbenchRefreshProbe;
      original?.focus();
      return {
        connected: Boolean(original?.isConnected),
        focused: document.activeElement === original,
        marker: original?.dataset.refreshProbe,
        value: original?.value
      };
    });
    assert.deepEqual(probeDuringRefresh, { connected: true, focused: true, marker: 'same-node', value: '7' });
    refreshGate.release.resolve();
    await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible();
    await expect(consumed).toHaveValue('7');
    await expect(consumed).toHaveAttribute('data-refresh-probe', 'same-node');
    await page.screenshot({ path: path.join(artifacts, 'refresh-preserves-draft.png'), fullPage: true });

    // A failed read must leave the last successful screen usable and clearly
    // identify the snapshot as stale until a retry succeeds.
    failProductionReads = 10;
    await button(workbench, '刷新').click();
    await expect(page.getByRole('alert')).toContainText('隔离测试模拟读取失败');
    await expect(page.getByTestId('workbench-sync-status')).toContainText('当前显示上次成功数据');
    await expect(consumed).toHaveValue('7');
    failProductionReads = 0;
    await button(workbench, '重新读取').click();
    await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible();
    await expect(consumed).toHaveValue('7');

    // Empty search results should explain the state and offer a one-tap reset.
    await button(workbench, '库存').click();
    await page.getByLabel('搜索库存').locator('input').fill('没有这款纸板');
    await expect(page.getByTestId('workbench-stock-empty')).toContainText('没有找到匹配库存');
    await button(page.getByTestId('workbench-stock-empty'), '清空搜索').click();
    await expect(page.getByTestId('workbench-board')).toContainText('刷新验收纸板厂');
    await button(workbench, '纸箱').click();
    await page.getByLabel('搜索库存').locator('input').fill('没有这款纸箱');
    await expect(page.getByTestId('workbench-stock-empty')).toContainText('没有找到匹配库存');
    await button(page.getByTestId('workbench-stock-empty'), '清空搜索').click();
    await expect(page.getByTestId('workbench-carton')).toContainText('刷新验收纸箱');

    // Opening a prior collection detail and then taking the supplier shortcut
    // must not reopen the stale detail over the requested supplier bill view.
    await page.goto(origin + '/#/pages/business-center/index');
    await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible();
    await button(page, '刷新验收客户 · 收款记录').click();
    await expect(page.getByRole('dialog', { name: '流水详情' })).toBeVisible();
    await page.getByRole('button', { name: '关闭流水详情' }).click();
    await expect(page.getByRole('dialog', { name: '流水详情' })).toHaveCount(0);
    await button(workbench, '总台').click();
    await button(workbench, '入库').click();
    await button(workbench, '供货商 / 付款').click();
    await expect(page.getByTestId('finance-center')).toBeVisible();
    await expect(page.getByTestId('finance-supplier-view')).toBeVisible();
    await expect(page.getByRole('dialog', { name: '流水详情' })).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, 'supplier-shortcut-clears-stale-entry.png'), fullPage: true });

    assert.deepEqual(errors, []);
    console.log('PASS workbench refresh state: delayed first load, retained snapshot/form draft across successful and failed reads, retry, stock no-match recovery, and supplier shortcut clears prior ledger detail.');
  } finally {
    // Settle all gated handlers first, then drain Playwright route callbacks
    // before closing the isolated browser context.
    for (const gate of productionGates) gate.release.resolve();
    failProductionReads = 0;
    for (const browserContext of contexts) {
      await browserContext.unrouteAll({ behavior: 'wait' });
      await browserContext.close();
    }
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
