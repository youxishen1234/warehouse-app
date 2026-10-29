const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('../backend/node_modules/express');
const { chromium, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const webRoot = path.resolve(process.env.DEMO_WEB_DIR || 'dist');
const routes = [
  ['/pages/home/index', '业务总台'],
  ['/pages/customers/index', '客户管理'],
  ['/pages/inventory/index', '库存管理'],
  ['/pages/finance/index', '收付款'],
  ['/pages/suppliers/index', '供货商管理'],
  ['/pages/print-center/index', '打印中心']
];
const pageDirectories = fs.readdirSync(path.join(root, 'src/pages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();

assert.deepEqual(pageDirectories, ['customers', 'finance', 'home', 'inventory', 'print-center', 'suppliers']);
assert.ok(fs.existsSync(path.join(webRoot, 'index.html')), `Missing H5 build: ${webRoot}`);
assert.ok(fs.existsSync(path.join(webRoot, 'preview-pages/dimension-input.js')), 'Missing dimension input script');

const app = express();
app.use(express.static(webRoot));
const server = app.listen(0, '127.0.0.1');

async function main() {
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {});
  const failures = [];

  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', error => failures.push(`pageerror ${error.message}`));
    page.on('response', response => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    });

    for (const [route, title] of routes) {
      await page.goto(`${origin}/#${route}`);
      const frame = page.frameLocator('iframe[title="曙光库存业务页面"]');
      await expect(frame.getByRole('heading', { name: title, exact: true })).toBeVisible();
    }

    await page.goto(`${origin}/preview-pages/customers.html`);
    await page.locator('.customer-card').first().click();
    await page.getByRole('button', { name: '＋ 添加货物' }).click();
    await page.locator('#s-name').fill('五层纸板');
    await page.locator('#s-size').fill('120080');
    await expect(page.locator('#s-size')).toHaveValue('120×80');
    await page.locator('#s-name').fill('普通纸箱');
    await page.locator('#s-size').fill('403030');
    await expect(page.locator('#s-size')).toHaveValue('40×30×30');

    await page.goto(`${origin}/preview-pages/management.html?view=stock&action=board-in`);
    await page.locator('#cb-carton').fill('403030');
    await expect(page.locator('#cb-carton')).toHaveValue('40×30×30');

    await page.goto(`${origin}/preview-pages/management.html?view=stock&action=carton-in`);
    await page.locator('#ci-size').fill('503530');
    await expect(page.locator('#ci-size')).toHaveValue('50×35×30');

    await page.goto(`${origin}/preview-pages/management.html?view=suppliers`);
    await page.locator('.row-card').first().click();
    await page.getByRole('button', { name: '＋ 添加' }).click();
    await page.locator('#sp-size').fill('120100');
    await expect(page.locator('#sp-size')).toHaveValue('120×100');

    await page.goto(`${origin}/preview-pages/print.html`);
    await page.getByRole('button', { name: '手动填写送货单' }).click();
    const line = page.locator('.manual-line').first();
    await line.locator('[data-k="goods"]').fill('五层纸板');
    await line.locator('[data-k="spec"]').fill('120100');
    await expect(line.locator('[data-k="spec"]')).toHaveValue('120×100');
    await line.locator('[data-k="goods"]').fill('五层纸箱');
    await line.locator('[data-k="spec"]').fill('403030');
    await expect(line.locator('[data-k="spec"]')).toHaveValue('40×30×30');

    assert.deepEqual(failures, []);
    console.log(`PASS: six demo routes and automatic dimension input (${routes.length} routes)`);
  } finally {
    await browser.close();
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => server.close());
