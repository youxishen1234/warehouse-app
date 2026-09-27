const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');

async function main() {
  process.env.TEAM_PREVIEW_PORT = '0';
  const { server, db } = await require('../scripts/team-preview.cjs')();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = path.dirname(process.env.WAREHOUSE_DATA_FILE);
  const a = db.addProduct({ name: '回归纸板A', specification: '1000×500/B', length: 1200, width: 600, unit: '张', price: 2.5, stock: 20 });
  const b = db.addProduct({ name: '回归纸箱B', specification: '800×400/A', unit: '箱', price: 4, stock: 10 });
  db.addSupplier({ name: '回归供应商' }); db.addCustomer({ name: '回归客户' });
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
    page.on('response', response => { if (response.status() >= 400 && /\.(js|css)(\?|$)/.test(response.url())) failedAssets.push(response.url()); });
    const input = placeholder => page.locator(`input[placeholder="${placeholder}"]:visible`);
    const text = value => page.getByText(value, { exact: true }).filter({ visible: true });
    const chooseProduct = async (name, selectedText) => {
      await text(selectedText || '选择已有商品').last().click();
      await input('搜索商品名称、规格、楞型').fill(name);
      await text(name).click();
    };
    await page.goto(base + '/pages/inbound/index');
    await text('入库开单').waitFor();
    await page.locator('.team-boot').waitFor({ state: 'detached' });
    await chooseProduct(a.name);
    await expect(input('入库单价')).toHaveValue('2.5');
    await chooseProduct(b.name, `${a.name} · 张`);
    await expect(input('入库单价')).toHaveValue('4');
    await expect(input('如 1550×705/A（选填）')).toHaveValue('800×400/A');
    await chooseProduct(a.name, `${b.name} · 箱`);
    await input('计划数量').fill('10'); await input('实际入库数量').fill('8');
    await text('货款合计：¥20.00').waitFor();
    await text('实际面积：5.7600 ㎡').waitFor();
    await page.screenshot({ path: 'release/stock-check/inbound-before.png', fullPage: true });
    await page.getByText('确认入库 · ¥20.00', { exact: true }).click();
    await expect.poll(() => db.getProduct(a.id).stock).toBe(28);
    await text('导出 CSV').waitFor();
    const downloadPromise = page.waitForEvent('download'); await text('导出 CSV').click();
    const download = await downloadPromise;
    await download.saveAs('release/stock-check/inbound.csv');
    const csv = fs.readFileSync('release/stock-check/inbound.csv', 'utf8'); assert.match(csv, /实际入库/); assert.match(csv, /5.76/);
    await page.goto(base + '/pages/outbound/index');
    await text('出库开单').waitFor(); await chooseProduct(a.name);
    await input('出库数量').fill('29');
    await text('库存不足，请减少数量').waitFor();
    await text('确认出库').click(); assert.equal(db.getProduct(a.id).stock, 28);
    await input('出库数量').fill('3'); await input('出库单价').fill('1.005');
    await text('＋ 添加商品').click(); await chooseProduct(b.name);
    await input('出库数量').nth(1).fill('2'); await input('出库单价').nth(1).fill('0.335');
    await text('共 2 项 · 合计出库金额 ¥3.69').waitFor();
    await page.screenshot({ path: 'release/stock-check/outbound-before.png', fullPage: true });
    await text('确认出库').dblclick();
    await expect.poll(() => db.getProduct(a.id).stock).toBe(25); assert.equal(db.getProduct(b.id).stock, 8);
    assert.equal(db.listTx({ type: 'out' }).length, 2);
    await text('作废').first().click(); await text('确定').click();
    await expect.poll(() => db.listTx({ type: 'out' }).length).toBe(1);
    await text('作废').first().click(); await text('确定').click();
    await expect.poll(() => db.getProduct(a.id).stock).toBe(28);
    await expect.poll(() => db.getProduct(b.id).stock).toBe(10);
    await page.goto(base + '/pages/inbound/index'); await text('入库开单').waitFor();
    await page.getByText(/入库单 #1 · 已入库/).click();
    await text('作废整张入库单').click(); await text('确定').click();
    await expect.poll(() => db.getProduct(a.id).stock).toBe(20);
    await page.reload(); await text('入库开单').waitFor(); await page.getByText(/入库单 #1 · 已作废/).waitFor();
    const routes = [...new Set([...fs.readFileSync('src/app.config.ts', 'utf8').matchAll(/'pages\/([^']+)'/g)].map(match => match[1]))];
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of routes) {
        await page.goto(base + '/pages/' + route);
        await expect(page.locator('.taro_page:visible').last()).not.toBeEmpty();
        await page.locator('.team-boot').waitFor({ state: 'detached' });
        await page.waitForTimeout(400);
        if (['inbound/index', 'outbound/index'].includes(route)) {
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow: ${route} ${width}`);
          await page.screenshot({ path: `release/stock-check/${process.env.STOCK_BROWSER || 'chromium'}-${route.split('/')[0]}-${width}.png`, fullPage: true });
        }
      }
    }
    assert.deepEqual(errors, []); assert.deepEqual(failedAssets, []);
    console.log(JSON.stringify({ engine: process.env.STOCK_BROWSER || 'chromium', routes: routes.length, widths: [390, 1280], realPosting: 'passed', csvDownload: 'passed', voidAndStock: 'passed', doubleClick: 'passed', pageErrors: errors, failedAssets, blockedExternalPaths: [...new Set(blocked)] }, null, 2));
  } catch (error) {
    if (activePage) { await activePage.screenshot({ path: 'release/stock-check/failure.png', fullPage: true }); console.error({ url: activePage.url(), text: (await activePage.locator('body').innerText()).slice(0, 1800), errors, failedAssets, blocked }); console.error(await activePage.evaluate(() => [...document.querySelectorAll('taro-scroll-view-core, taro-pull-to-refresh-core, [class*=btnPrimary]')].map(el => ({ tag: el.tagName, class: el.className, rect: el.getBoundingClientRect().toJSON(), scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, height: getComputedStyle(el).height, overflow: getComputedStyle(el).overflow, shadow: el.shadowRoot?.innerHTML.slice(0, 800) })))); }
    throw error;
  }
  finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
