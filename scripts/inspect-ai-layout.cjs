const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { webkit } = require('playwright');
const root = path.resolve(process.env.AI_WEB_DIR || 'dist');
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(root, name === '/' ? 'index.html' : name);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
    page.on('pageerror', e => console.error(e.message));
    await page.route(/\/api\//, route => {
      let data = {};
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/auth/guest')) data = { token: 'test-token', user: { id: 'preview', username: 'preview', role: 'operator' } };
      if (url.pathname.endsWith('/ai/status')) data = { mode: 'rules', model: null, message: '尚未配置 AI 模型，可先试用基础指令和查询；照片识别需要视觉模型' };
      if (url.pathname.endsWith('/ai/tools')) data = { capabilities: [] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({success: true, data}) });
    });
    await page.goto('http://127.0.0.1:' + server.address().port + '/#/pages/ai-assistant/index');
    await page.getByText('今天想处理什么？', {exact:true}).waitFor();
    await page.screenshot({path: 'release/ai-before.png'});
    console.log(JSON.stringify(await page.evaluate(() => {
      return ['page', 'header', 'heading', 'subtitle', 'content', 'connection', 'grow', 'chip', 'textButton', 'composer', 'composerTools', 'messageInput', 'send'].map(k => {
        const e = document.querySelector('[class*="__' + k + '___"]'), s = e && getComputedStyle(e), b = e?.getBoundingClientRect();
        return {k, tag:e?.tagName, attrs:e?.getAttributeNames().map(n=>[n,e.getAttribute(n)]), width:b?.width, height:b?.height, css:s && {display:s.display,width:s.width,flex:s.flex,visibility:s.visibility,color:s.color,background:s.backgroundColor,font:s.fontSize}};
      });
    }), null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(e => {console.error(e); server.close(); process.exitCode=1;});
