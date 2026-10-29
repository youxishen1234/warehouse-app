const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');

async function main() {
  process.env.TEAM_PREVIEW_PORT = '0';
  process.env.TEAM_PREVIEW_DATA_DIR = path.join('.', 'release', 'stock-check', `browser-${process.env.STOCK_BROWSER || 'chromium'}`);
  const preview = await require('../scripts/team-preview.cjs')();
  const { server } = preview;
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = path.dirname(process.env.WAREHOUSE_DATA_FILE);
  const db = preview.db;
  const a = db.addProduct({ name: '回归纸板A', specification: '1000×500/B', length: 1200, width: 600, unit: '张', price: 2.5, stock: 20 });
  const b = db.addProduct({ name: '回归纸箱B', specification: '800×400/A', unit: '箱', price: 4, stock: 10 });
  db.addSupplier({ name: '回归供应商' }); const customer = db.addCustomer({ name: '回归客户' });
  db.addOrder({ order_no: 'OUTBOUND-UI', customer_id: customer.id, specification: a.specification, quantity: 200, unit: a.unit, unit_price: a.price, status: '生产中' });
  const engine = process.env.STOCK_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch();
  const errors = [], failedAssets = [], blocked = [];
  let activePage;
  fs.mkdirSync('release/stock-check', { recursive: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === base || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      if (['http://152.136.100.200', 'https://youxishen.online'].includes(url.origin) && url.pathname.startsWith('/api/')) {
        const response = await route.fetch({ url: base + url.pathname + url.search });
        return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization, If-Match, Idempotency-Key, X-Warehouse-Device', 'access-control-expose-headers': 'X-Warehouse-Revision', 'access-control-max-age': '600' } });
      }
      blocked.push(url.pathname); return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    activePage = page;
    page.on('pageerror', error => errors.push(error.message));
    if (process.env.STOCK_DIAGNOSTICS) {
      page.on('requestfailed', request => console.log('API failure', request.method(), new URL(request.url()).pathname, request.failure()?.errorText));
      page.on('response', response => { if (response.status() >= 400) console.log('HTTP failure', response.status(), new URL(response.url()).pathname); });
      page.on('pageerror', error => console.log('Page error detail', error.stack));
    }
    page.on('response', response => { if (response.status() >= 400 && /\.(js|css)(\?|$)/.test(response.url())) failedAssets.push(response.url()); });
    const input = placeholder => page.locator(`input[placeholder="${placeholder}"]:visible`);
    const text = value => page.getByText(value, { exact: true }).filter({ visible: true });
    const chooseProduct = async (name, selectedText) => {
      await text(selectedText || '选择已有商品').last().click();
      await input('搜索商品名称、规格、楞型').fill(name);
      await text(name).click();
    };
    await page.goto(base + '/pages/management/index?section=receipt');
    await text('入库开单').waitFor();
    await page.locator('.team-boot').waitFor({ state: 'detached' });
    await chooseProduct(a.name);
    await expect(input('入库单价')).toHaveValue('2.5');
    await chooseProduct(b.name, `${a.name} · 张`);
    await expect(input('入库单价')).toHaveValue('4');
    await expect(input('如 1550×705/A（选填）')).toHaveValue('800×400/A');
    await chooseProduct(a.name, `${b.name} · 箱`);
    await input('计划数量').fill('7'); await input('实际入库数量').fill('8');
    await text('货款合计：¥20.00').waitFor();
    await text('实际面积：5.7600 ㎡').waitFor();
    const barGeometry = async label => page.evaluate(name => {
      const bar = document.querySelector(`[aria-label="${name}"]`)?.closest('.board-confirm-rail');
      const rect = bar?.getBoundingClientRect();
      if (!rect) return null;
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewport: innerWidth, height: innerHeight, position: getComputedStyle(bar).position, bottomStyle: getComputedStyle(bar).bottom };
    }, label);
    const inboundBar = await barGeometry('入库确认');
    assert(inboundBar, 'shared inbound confirm bar should render');
    assert.equal(inboundBar.position, 'static');
    assert(inboundBar.left >= 0 && inboundBar.right <= inboundBar.viewport + 1, 'inbound confirm bar must fit the viewport');
    await page.getByLabel('入库确认').getByText('确认入库', { exact: true }).scrollIntoViewIfNeeded();
    const inboundVisible = await page.getByLabel('入库确认').boundingBox();
    assert(inboundVisible && inboundVisible.y + inboundVisible.height <= inboundBar.height, 'inbound confirm bar must be readable above the mobile navigation');
    await page.screenshot({ path: 'release/stock-check/inbound-before.png', fullPage: false });
    await page.getByLabel('入库确认').getByText('确认入库', { exact: true }).click();
    await page.getByText('实际入库超过计划', { exact: true }).waitFor();
    await page.getByText('继续入库', { exact: true }).click();
    await expect.poll(() => db.getProduct(a.id).stock).toBe(28);
    await text('导出 CSV').waitFor();
    const downloadPromise = page.waitForEvent('download'); await text('导出 CSV').click();
    const download = await downloadPromise;
    await download.saveAs('release/stock-check/inbound.csv');
    const csv = fs.readFileSync('release/stock-check/inbound.csv', 'utf8'); assert.match(csv, /实际入库/); assert.match(csv, /5.76/);
    await page.goto(base + '/pages/management/index?section=shipment');
    await text('出库开单').waitFor();
    await page.locator('[class*=orderOption]').filter({ hasText: a.specification }).click();
    const stockBeforeOutbound = db.getProduct(a.id).stock;
    await page.locator('[class*=fieldGrid] input').first().fill('10000000000000');
    await text(/库存不足，还缺/).waitFor();
    await page.getByLabel('出库确认').click({ position: { x: 10, y: 10 } }); assert.equal(db.getProduct(a.id).stock, stockBeforeOutbound);
    const quantity = Math.min(3, stockBeforeOutbound);
    await page.locator('[class*=fieldGrid] input').first().fill(String(quantity));
    await text(`本单金额 ¥${(quantity * a.price).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`).waitFor();
    const outboundBar = await barGeometry('出库确认');
    assert(outboundBar, 'shared outbound confirm bar should render');
    assert.equal(outboundBar.position, 'static');
    assert(outboundBar.left >= 0 && outboundBar.right <= outboundBar.viewport + 1, 'outbound confirm bar must fit the viewport');
    await page.getByLabel('出库确认').getByText('确认出库', { exact: true }).scrollIntoViewIfNeeded();
    const outboundVisible = await page.getByLabel('出库确认').boundingBox();
    assert(outboundVisible && outboundVisible.y + outboundVisible.height <= outboundBar.height, 'outbound confirm bar must be readable above the mobile navigation');
    await page.screenshot({ path: 'release/stock-check/outbound-before.png', fullPage: false });
    await page.getByLabel('出库确认').getByText('确认出库', { exact: true }).dblclick();
    await expect.poll(() => db.getProduct(a.id).stock).toBe(stockBeforeOutbound - quantity);
    assert.equal(db.listTx({ type: 'out' }).length, 1);
    assert.equal(db.getProduct(a.id).stock, stockBeforeOutbound - quantity);
    await page.goto(base + '/pages/management/index?section=receipt'); await text('入库开单').waitFor();
    const inboundNote = page.locator('[class*=note___]').filter({ hasText: '入库单 #1' });
    await expect(inboundNote).toContainText('已入库');
    await inboundNote.click();
    await text('作废整张入库单').click(); await text('确定').click();
    await text('入库单 #1 · 已作废').waitFor();
    // The receipt added 8 and was reversed, while the 3 unit outbound remains:
    // the original 20 unit balance must end at 17.
    assert.equal(db.getProduct(a.id).stock, 17);
    await expect.poll(() => db.listDeliveryNotes().find(note => note.id === 1)?.voided_at || 0).toBeGreaterThan(0);
    await page.reload(); await text('入库开单').waitFor();
    await expect.poll(async () => page.locator('[class*=note___]').filter({ hasText: '入库单 #1' }).innerText()).toContain('已作废');
    const routes = [...new Set([...fs.readFileSync('src/app.config.ts', 'utf8').matchAll(/'pages\/([^']+)'/g)].map(match => match[1]))].filter(route => ['inbound/index', 'outbound/index'].includes(route));
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of routes) {
        await page.goto(base + '/pages/' + route);
        await expect(page.locator('.taro_page:visible').last()).not.toBeEmpty();
        await page.locator('.team-boot').waitFor({ state: 'detached' });
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(400);
        if (['inbound/index', 'outbound/index'].includes(route)) {
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow: ${route} ${width}`);
          await page.screenshot({ path: `release/stock-check/${process.env.STOCK_BROWSER || 'chromium'}-${route.split('/')[0]}-${width}.png`, fullPage: true });
        }
      }
    }
    assert.deepEqual(errors, []); assert.deepEqual(failedAssets, []);
    console.log(JSON.stringify({ engine: process.env.STOCK_BROWSER || 'chromium', routes: routes.length, widths: [390, 1280], realPosting: 'passed', csvDownload: 'passed', voidAndStock: 'passed', doubleClick: 'passed', confirmBars: 'shared and viewport-safe', pageErrors: errors, failedAssets, blockedExternalPaths: [...new Set(blocked)] }, null, 2));
  } catch (error) {
    if (activePage) { await activePage.screenshot({ path: 'release/stock-check/failure.png', fullPage: true }); console.error({ url: activePage.url(), text: (await activePage.locator('body').innerText()).slice(0, 1800), errors, failedAssets, blocked }); console.error(await activePage.evaluate(() => [...document.querySelectorAll('taro-scroll-view-core, taro-pull-to-refresh-core, [class*=btnPrimary]')].map(el => ({ tag: el.tagName, class: el.className, rect: el.getBoundingClientRect().toJSON(), scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, height: getComputedStyle(el).height, overflow: getComputedStyle(el).overflow, shadow: el.shadowRoot?.innerHTML.slice(0, 800) })))); }
    throw error;
  }
  finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
