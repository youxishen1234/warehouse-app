// Run against a fresh H5 build with the isolated preview API; does not mutate real inventory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');
async function main() {
  process.env.TEAM_PREVIEW_PORT = '0';
  const web = process.env.BOARD_LABEL_WEB_DIR || process.env.TEAM_PREVIEW_WEB_DIR || 'dist';
  if (!fs.existsSync(require('node:path').join(web, 'index.html'))) throw new Error('请先设置 BOARD_LABEL_WEB_DIR 指向本地 H5 构建目录');
  process.env.TEAM_PREVIEW_WEB_DIR = web;
  const { server, db } = await require('../scripts/team-preview.cjs')();
  const batch = db.receiveBoard({
    supplier: '标签入口测试板厂', customerName: '客户搜索样例', material: '牛卡 / 高瓦',
    printPlate: '外箱正面版', printColor: '红 / 黑', date: require('../backend/stock-math').localDate(),
    boardLength: 120, boardWidth: 80, cartonLength: 40, cartonWidth: 30, cartonHeight: 20,
    fluteType: 'B', layers: 3, faceGsm: 150, linerGsm: 120, flutingGsm: 100,
    orderedQty: 100, receivedQty: 100, billedArea: 96, unitPrice: 2, location: 'A-01'
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route(/https?:\/\/[^/]+\/api\//, async route => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: base + url.pathname + url.search }) });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const active = () => page.locator('.taro_page:visible').last();
    await page.goto(base + '/pages/board-stock/index');
    await active().getByTestId('workbench-board').first().waitFor();
    const search = active().getByLabel('搜索库存').locator('input');
    await search.fill('客户搜索样例');
    await active().getByTestId('workbench-board').first().waitFor();
    await search.fill('外箱正面版'); await active().getByTestId('workbench-board').first().waitFor();
    await search.fill('颜色肯定不存在'); await active().getByTestId('workbench-board').waitFor({ state: 'hidden' });
    await search.fill(''); await active().getByTestId('workbench-board').filter({ hasText: batch.id }).getByText('查看 / 同规格入库', { exact: true }).click();
    await active().getByText('打印批次标签', { exact: true }).click();
    await page.waitForURL(/pages\/label-print\/index/);
    const route = new URL(page.url()).hash;
    const params = new URLSearchParams(route.slice(route.indexOf('?') + 1));
    assert.equal(params.get('kind'), 'paperboard-batch'); assert.equal(params.get('id'), batch.id);
    await active().getByText('电脑 USB 打印 K3', { exact: true }).waitFor();
    await page.goto(base + '/pages/board-detail/index?id=' + encodeURIComponent(batch.id));
    for (const [label, value] of [['客户', '客户搜索样例'], ['材质/配纸', '牛卡 / 高瓦'], ['印刷版名', '外箱正面版'], ['颜色', '红 / 黑']]) {
      await active().locator('.board-detail-row').filter({ hasText: label }).getByText(value, { exact: true }).waitFor();
    }
    await active().getByText('打印批次标签', { exact: true }).click();
    await page.waitForURL(/pages\/label-print\/index/);
    const detailParams = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
    assert.equal(detailParams.get('kind'), 'paperboard-batch'); assert.equal(detailParams.get('id'), batch.id);
    console.log('PASS: customer/material/plate/color search, batch detail fields, stock and detail print routes, USB is default transport');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
