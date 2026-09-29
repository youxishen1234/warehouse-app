// UI fixtures are isolated from production. Business mutation coverage lives
// in stock-browser.cjs; live-api-cors-browser.cjs performs real server reads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit } = require('@playwright/test');
const root = path.resolve(process.env.UI_WEB_DIR || 'dist');
const output = path.resolve('release/ui-redesign');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

async function check(engine, name, base) {
  const browser = await engine.launch();
  try {
    for (const width of [320, 390, 430]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, colorScheme: width === 430 ? 'dark' : 'light' });
      page.setDefaultTimeout(10000);
      const errors = [];
      const counts = new Map();
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        counts.set(url.pathname, (counts.get(url.pathname) || 0) + 1);
        let data = [];
        if (url.pathname.endsWith('/auth/guest')) data = { token: 'ui-fixture', user: { id: '1', username: 'preview', role: 'operator' } };
        if (url.pathname.endsWith('/stats')) data = { todayIn: 16, todayOut: 7, totalProducts: 1, totalStock: 24, lowStock: 0, totalValue: 60 };
        if (url.pathname.endsWith('/sync')) data = { revision: 1 };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      });
      await page.goto(base);
      await page.locator('[class*=actionIn___]').waitFor();
      await page.locator('.team-boot').waitFor({ state: 'detached' });
      for (const [index, route] of ['home', 'inbound', 'outbound', 'mine'].entries()) {
        await page.getByRole('button', { name: ['首页', '入库', '出库', '我的'][index], exact: true }).click();
        await page.waitForURL(new RegExp('/pages/' + route + '/index'));
        const active = page.locator('.taro_page:visible').last();
        await active.locator('taro-scroll-view-core').waitFor();
        await page.evaluate(() => {
          document.querySelectorAll('.taro_page, taro-scroll-view-core').forEach(el => { el.scrollTop = 0; });
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(180);
        const overflow = await active.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
        assert.ok(overflow.scroll <= overflow.width + 1, `${name}/${width}/${route}: horizontal overflow ${JSON.stringify(overflow)}`);
        if (route === 'home') {
          for (const selector of ['[class*=actionIn___]', '[class*=actionOut___]']) {
            const style = await active.locator(selector).evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, gradient: getComputedStyle(el).backgroundImage }));
            assert.notEqual(style.bg, 'rgb(255, 255, 255)', 'white text must retain its coloured action surface');
            assert.notEqual(style.gradient, 'none', 'global rules must not erase action gradients');
          }
          const labels = await active.locator('[class*=funcText___], .sg-corrugated-text').allTextContents();
          for (const label of ['库存查询', '商品管理', '客户管理', '供应商管理', '出入库记录', '新增商品', '流水', '瓦楞计算']) assert.ok(labels.includes(label), label);
          const calculator = await active.locator('.sg-corrugated-text').evaluate(el => ({ whiteSpace: getComputedStyle(el).whiteSpace, width: el.getBoundingClientRect().width, scroll: el.scrollWidth }));
          assert.equal(calculator.whiteSpace, 'nowrap');
          assert.ok(calculator.width >= calculator.scroll - 1, 'calculator label is not squeezed into a vertical column');
        } else if (route !== 'mine') {
          const hero = await active.locator('[class*=hero___]').evaluate(el => getComputedStyle(el).backgroundImage);
          assert.notEqual(hero, 'none');
          const selector = route === 'inbound' ? '[class*=fixedSave___]' : '[class*=btnPrimary___]';
          const button = active.locator(selector);
          const rect = await button.boundingBox();
          const bar = await page.locator('.sg-glass-dock').boundingBox();
          assert.ok(rect.y >= 0 && rect.y + rect.height <= bar.y - 4, `${route}: CTA overlaps bottom bar ${JSON.stringify({ rect, bar })}`);
          assert.equal(await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'submit center receives taps');
          const bottomItem = active.locator('[class*=empty___]').last();
          await bottomItem.scrollIntoViewIfNeeded();
          await active.evaluate(el => el.querySelectorAll('taro-scroll-view-core').forEach(scroller => { scroller.scrollTop = scroller.scrollHeight; }));
          const last = await bottomItem.boundingBox();
          assert.ok(last.y + last.height <= rect.y, `${route}: last record remains accessible above submit`);
          await active.evaluate(el => { el.scrollTop = 0; el.querySelectorAll('taro-scroll-view-core').forEach(s => { s.scrollTop = 0; }); });
        } else {
          await active.getByText('已连接', { exact: true }).waitFor();
          assert.equal(await active.locator('[class*=menuCard___]').count(), 11);
          await active.getByText('自定义文案', { exact: true }).waitFor();
          const labelColor = await active.locator('[class*=menuText___]').first().evaluate(el => getComputedStyle(el).color);
          assert.equal(labelColor, 'rgb(23, 34, 53)', 'settings labels retain contrast on light cards');
        }
        await page.screenshot({ path: path.join(output, `${name}-${width}-${route}.png`) });
      }
      await page.getByText('当前服务节点', { exact: true }).click();
      await page.getByText('测试连接', { exact: true }).click();
      await page.getByText('连接成功 ✓ 服务器可以正常访问', { exact: true }).waitFor();
      await page.getByRole('textbox', { name: 'http:// 或 https:// 开头的地址' }).fill('https://untrusted.invalid');
      await page.getByText('测试连接', { exact: true }).click();
      await page.getByText('地址必须是共享仓库服务器地址', { exact: true }).waitFor();
      await page.locator('[class*=addrDialog___]').getByText('取消', { exact: true }).click();
      await page.locator('[class*=menuCard___]').filter({ hasText: '客户订单' }).click();
      await page.getByText('暂无订单', { exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      const orderReads = counts.get('/api/orders');
      assert.ok(orderReads >= 1 && orderReads <= 3, 'orders must settle without a repeated-load loop');
      await page.getByText('＋新增订单', { exact: true }).click();
      await page.locator('input[placeholder="订单号"]').fill('UI-LOCAL-ONLY');
      await page.waitForTimeout(350);
      assert.equal(counts.get('/api/orders'), orderReads, 'editing the draft must not recreate the data loader');
      assert.deepEqual(errors, [], `${name}/${width}: page errors`);
      await page.close();
      console.log(`${name} ${width}px: four pages, visible actions, labels, dock/submit clearance, connection dialog passed`);
    }
  } finally { await browser.close(); }
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) await check(engine, name, base); }
  finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
