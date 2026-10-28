const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const artifacts = path.resolve(process.env.WORKBENCH_LAYOUT_EVIDENCE_DIR || 'release/workbench-layout-20261024/evidence');
  fs.mkdirSync(artifacts, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(artifacts, 'isolated-data-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(temporary, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(temporary, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], orders: [], ledger: [],
    stocktakes: [], delivery_notes: [], production_records: [], board_batches: [], board_movements: [],
    _meta: { schemaVersion: 1, nextProductId: 1, nextCustomerId: 1, nextSupplierId: 1, nextTransactionId: 1, nextLedgerId: 1 }
  }));

  const db = require('../backend/db');
  const longProductName = '超长商品名称用于验证窄屏业务记录不会挤出卡片边界的纸箱规格';
  const product = db.addProduct({
    name: longProductName, category: '纸箱', specification: '30×20×15 cm', unit: '个',
    price: 2, stock: 10, safety_stock: 2
  });
  db.stockOut(product.id, 1, '布局回归测试', 'isolated fixture');

  const app = express();
  app.use(express.json({ limit: '18mb' }));
  app.use('/api', require('../backend/team')(db));
  app.use(express.static(path.resolve(process.env.WORKBENCH_POLISH_WEB_DIR || process.env.TARO_OUTPUT_DIR || 'release/workbench-layout-20261024/web')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const contexts = [];
  const errors = [];

  const setup = async () => {
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
        const response = await route.fetch({ url: origin + url.pathname + url.search });
        return route.fulfill({
          response,
          headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Warehouse-Revision' }
        });
      }
      return url.origin === origin ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(12000);
    return page;
  };
  const page = await setup();
  const button = (scope, text) => scope.getByText(text, { exact: true }).last().locator('xpath=ancestor-or-self::*[self::taro-button-core or self::button][1]');
  const home = page.getByTestId('simple-workbench');

  try {
    await page.goto(origin + '/#/pages/business-center/index');
    await expect(page.getByText('快捷办理', { exact: true })).toBeVisible();
    await expect(page.getByText('服务器数据已读取 · 多设备自动同步', { exact: true })).toBeVisible();
    await expect(page.getByTestId('workbench-version')).toContainText('网页版本');
    await expect(page.getByTestId('workbench-today')).toContainText(longProductName);
    const activity = page.getByTestId('workbench-today').locator('taro-button-core').first();

    for (const width of [320, 390, 430, 736, 1280]) {
      await page.setViewportSize({ width, height: width === 320 ? 700 : width === 390 ? 844 : 1068 });
      const root = page.getByTestId('simple-workbench');
      assert.ok(await root.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `workbench width ${width} has no horizontal overflow`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `document width ${width} has no horizontal overflow`);

      const cards = page.getByTestId('workbench-actions').locator('taro-button-core');
      assert.equal(await cards.count(), 4, 'four primary business actions remain visible');
      const cardMetrics = await cards.evaluateAll(elements => elements.map(card => {
        const guide = card.querySelector('[class*="entryGuide"]');
        const label = guide?.lastElementChild;
        const cardRect = card.getBoundingClientRect();
        const guideRect = guide?.getBoundingClientRect();
        const labelRect = label?.getBoundingClientRect();
        const range = document.createRange();
        if (label) range.selectNodeContents(label);
        const textLines = Array.from(range.getClientRects()).map(rect => ({
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom
        }));
        return {
          card: { left: cardRect.left, right: cardRect.right, top: cardRect.top, bottom: cardRect.bottom, height: cardRect.height },
          guide: guideRect && { left: guideRect.left, right: guideRect.right, top: guideRect.top, bottom: guideRect.bottom },
          label: labelRect && { left: labelRect.left, right: labelRect.right, top: labelRect.top, bottom: labelRect.bottom },
          textLines
        };
      }));
      assert.equal(cardMetrics.length, 4);
      assert.ok(cardMetrics[0].card.left < cardMetrics[1].card.left && cardMetrics[2].card.left < cardMetrics[3].card.left, `primary actions remain in two columns at ${width}px`);
      assert.ok(Math.abs(cardMetrics[0].card.top - cardMetrics[1].card.top) < 2 && Math.abs(cardMetrics[2].card.top - cardMetrics[3].card.top) < 2 && cardMetrics[2].card.top > cardMetrics[0].card.top, `primary actions remain in a two-by-two grid at ${width}px`);
      for (const [index, metric] of cardMetrics.entries()) {
        assert.ok(metric.card.height >= 44, `action ${index} has a usable touch target at ${width}px`);
        assert.ok(metric.guide && metric.label, `action ${index} guide is rendered at ${width}px`);
        assert.ok(metric.guide.left >= metric.card.left && metric.guide.right <= metric.card.right + 1, `action ${index} guide remains inside its card at ${width}px`);
        assert.ok(metric.label.left >= metric.guide.left && metric.label.right <= metric.guide.right + 1, `action ${index} guide text remains inside the guide at ${width}px`);
        assert.ok(metric.textLines.length > 0, `action ${index} guide text is laid out at ${width}px`);
        assert.ok(metric.textLines.every(line => line.left >= metric.guide.left - 1 && line.right <= metric.guide.right + 1), `action ${index} guide text has no clipped line at ${width}px`);
        assert.ok(metric.textLines.every(line => line.bottom <= metric.card.bottom + 1), `action ${index} guide text stays inside the card at ${width}px`);
      }

      const titleRect = await activity.locator('[class*="activityTitle"]').evaluate(element => {
        const rect = element.getBoundingClientRect();
        const parent = element.closest('taro-button-core').getBoundingClientRect();
        return { left: rect.left, right: rect.right, parentLeft: parent.left, parentRight: parent.right };
      });
      assert.ok(titleRect.left >= titleRect.parentLeft && titleRect.right <= titleRect.parentRight + 1, `long activity title stays in its row at ${width}px`);
      if (width <= 430) await page.screenshot({ path: path.join(artifacts, `home-${width}.png`), fullPage: true });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + '/#/pages/home/index');
    await page.reload();
    await expect(page.getByTestId('workbench-summary')).toBeVisible();
    const embeddedRoot = page.getByTestId('simple-workbench').filter({ visible: true });
    const embeddedCards = embeddedRoot.getByTestId('workbench-actions').locator('taro-button-core');
    const embeddedMetrics = await embeddedCards.evaluateAll(elements => elements.map(card => {
      const rect = card.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    assert.equal(embeddedMetrics.length, 4);
    assert.ok(embeddedMetrics[0].left < embeddedMetrics[1].left && embeddedMetrics[2].left < embeddedMetrics[3].left, 'embedded home has two columns at 390px');
    assert.ok(Math.abs(embeddedMetrics[0].top - embeddedMetrics[1].top) < 2 && Math.abs(embeddedMetrics[2].top - embeddedMetrics[3].top) < 2 && embeddedMetrics[2].top > embeddedMetrics[0].top, 'embedded home has a compact two-by-two grid at 390px');
    const bottomInset = await embeddedRoot.evaluate(element => ({
      clearance: parseFloat(getComputedStyle(element).paddingBottom),
      dockSpace: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sg-workbench-dock-space')) || 84,
      backingContent: getComputedStyle(element, '::after').content
    }));
    assert.ok(bottomInset.clearance >= bottomInset.dockSpace, 'embedded home reserves the shared liquid-dock space: ' + JSON.stringify(bottomInset));
    assert.equal(bottomInset.backingContent, 'none', 'embedded home no longer paints an opaque strip over the dock');
    const shell = await page.evaluate(() => {
      const activePage = Array.from(document.querySelectorAll('.taro_page'))
        .find(element => getComputedStyle(element).display !== 'none');
      return {
        enabled: document.documentElement.hasAttribute('data-workbench-shell'),
        background: getComputedStyle(document.documentElement).backgroundColor,
        pagePaddingTop: activePage ? getComputedStyle(activePage).paddingTop : ''
      };
    });
    assert.equal(shell.enabled, true, 'workbench routes opt into the light scroll shell');
    assert.equal(shell.background, 'rgb(244, 247, 251)', 'iOS overscroll reveals the workbench background');
    assert.equal(shell.pagePaddingTop, '0px', 'workbench masthead owns the top safe area without double padding');
    const footer = embeddedRoot.getByTestId('workbench-sync-status');
    await footer.scrollIntoViewIfNeeded();
    const footerBox = await footer.boundingBox();
    const dockBox = await page.locator('taro-tabbar').boundingBox();
    assert.ok(footerBox.y + footerBox.height <= dockBox.y, 'scrolled footer stays above the liquid dock: ' + JSON.stringify({ footerBox, dockBox }));
    await page.screenshot({ path: path.join(artifacts, 'home-embedded-390.png'), fullPage: true });

    await page.goto(origin + '/#/pages/business-center/index');
    await page.reload();
    await expect(page.getByText('快捷办理', { exact: true })).toBeVisible();
    await button(home, '收付款 / 账单').click();
    await expect(page.getByTestId('finance-center')).toBeVisible();
    await expect(page.getByTestId('finance-tab-ledger')).toBeVisible();
    await expect(page.getByTestId('finance-tab-customer')).toBeVisible();
    await expect(page.getByTestId('finance-tab-supplier')).toBeVisible();
    await page.getByTestId('finance-tab-customer').click();
    await expect(page.getByTestId('finance-customer-view')).toBeVisible();
    await page.getByTestId('finance-tab-supplier').click();
    await expect(page.getByTestId('finance-supplier-view')).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'finance-entry-390.png'), fullPage: true });

    await page.getByLabel('返回总台').click();
    await expect(page.getByText('快捷办理', { exact: true })).toBeVisible();
    await page.locator('.sg-glass-items [data-tab="2"]').click();
    await page.waitForURL(/pages\/inventory\/index/);
    const inventory = page.getByTestId('simple-workbench').filter({ visible: true }).last();
    await expect(inventory).toHaveAttribute('data-panel', 'stock');
    await expect(inventory.getByText('查看库存', { exact: true })).toBeVisible();
    await button(inventory, '纸箱').click();
    await page.setViewportSize({ width: 320, height: 320 });
    await button(page.getByTestId('workbench-carton'), '盘点 / 调整库存').click();
    const dialog = page.getByRole('dialog', { name: '库存盘点' });
    await expect(dialog).toBeVisible();
    const dialogMetrics = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    });
    assert.ok(dialogMetrics.top >= 0 && dialogMetrics.bottom <= 320, 'stocktake dialog fits inside a short phone viewport');
    assert.ok(dialogMetrics.scrollHeight > dialogMetrics.clientHeight, 'dialog contents remain reachable through internal scrolling when screen height is short');
    assert.deepEqual(errors, []);
    console.log('PASS business-center layout: compact two-by-two actions at 320/390/430/736/1280px; guidance, long activity title, finance entry and short-screen dialog verified.');
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
