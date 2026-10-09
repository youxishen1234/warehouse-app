const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(process.env.AI_WEB_DIR || 'dist');
const output = path.resolve(process.env.AI_PREVIEW_DIR || 'release/ai-preview');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/\/api\//, route => {
      const pathname = new URL(route.request().url()).pathname;
      const data = pathname.endsWith('/auth/guest')
        ? { token: 'preview-token', user: { id: 'preview', username: 'preview', role: 'operator' } }
        : pathname.endsWith('/ai/status')
          ? { mode: 'model', model: 'deepseek-v4-flash', message: '模型已配置；照片识别需要该模型支持图片输入', voice: { available: true, maxSeconds: 60, maxBytes: 6291456 } }
          : pathname.endsWith('/ai/tools') ? { capabilities: [] } : {};
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/#/pages/ai-assistant/index`);
    await page.locator('[data-ai-chat="20261004-wechat"]').waitFor();
    await page.screenshot({ path: path.join(output, 'deepseek-style-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '更多发送方式', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'deepseek-style-plus.png'), fullPage: true });
    await page.getByRole('button', { name: '发语音', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'deepseek-style-voice-ready.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: path.join(output, 'deepseek-style-desktop.png'), fullPage: true });
    const bounds = await page.locator('[data-ai-assistant]').evaluate(rootElement => {
      const nodes = [...rootElement.querySelectorAll('*')].filter(node => node.getClientRects().length);
      return { right: Math.max(...nodes.map(node => node.getBoundingClientRect().right)), bottom: Math.max(...nodes.map(node => node.getBoundingClientRect().bottom)) };
    });
    console.log(JSON.stringify({ errors, bounds, mobile: path.join(output, 'deepseek-style-mobile.png'), plus: path.join(output, 'deepseek-style-plus.png'), voice: path.join(output, 'deepseek-style-voice-ready.png'), desktop: path.join(output, 'deepseek-style-desktop.png') }, null, 2));
    if (errors.length || bounds.right > 1441) process.exitCode = 1;
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
