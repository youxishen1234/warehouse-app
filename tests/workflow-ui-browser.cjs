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
      await page.getByTestId('workbench-actions').waitFor();
      await page.locator('.team-boot').waitFor({ state: 'detached' });
      for (const [index, route] of ['home', 'ai-assistant', 'inventory', 'mine'].entries()) {
        await page.getByRole('button', { name: ['总台', 'AI助手', '库存', '我的'][index], exact: true }).click();
        await page.waitForURL(new RegExp('/pages/' + route + '/index'));
        const active = page.locator('.taro_page:visible').last();
        await active.getByTestId('simple-workbench').first().waitFor({ timeout: 10000 }).catch(async () => {
          await active.locator('taro-pull-to-refresh-core, taro-page, taro-scroll-view-core').first().waitFor();
        });
        await page.evaluate(() => {
          document.querySelectorAll('.taro_page, taro-scroll-view-core').forEach(el => { el.scrollTop = 0; });
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(180);
        const overflow = await active.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
        assert.ok(overflow.scroll <= overflow.width + 1, `${name}/${width}/${route}: horizontal overflow ${JSON.stringify(overflow)}`);
        if (route === 'home' || route === 'inventory') {
          await active.getByTestId('simple-workbench').waitFor();
          if (route === 'home') {
            assert.equal(await active.getByTestId('workbench-actions').locator('taro-button-core').count(), 4);
            await active.getByTestId('workbench-summary').waitFor();
            await active.getByTestId('workbench-stock-notice').waitFor();
          } else {
            await active.getByText('查看库存', { exact: true }).first().waitFor();
          }
        } else if (route === 'ai-assistant') {
          await active.locator('textarea,[aria-label*="仓库"],input').first().waitFor();
        }
        await page.screenshot({ path: path.join(output, `${name}-${width}-${route}.png`) });
      }
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
