const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

async function serveWeb(directory) {
  const root = path.resolve(directory);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.setHeader('content-type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

async function isolateBusinessAPI(context, origin, options = {}) {
  const writes = [];
  await context.addInitScript(() => localStorage.setItem('sg_getting_started_seen_v1', JSON.stringify({ data: true })));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !url.pathname.endsWith('/auth/guest')) writes.push(request.method() + ' ' + url.pathname);
    let data = [];
    if (url.pathname.endsWith('/auth/guest')) data = { token: 'navigation-check', user: { id: 1, username: 'navigation-check', role: 'viewer' } };
    if (url.pathname === '/api/customers' && options.customers) data = Array.from({ length: options.customers }, (_, index) => ({ id: index + 1, name: '滚动验收-' + (index + 1), debt: 0, specs: [] }));
    if (url.searchParams.has('page')) data = { items: Array.isArray(data) ? data : [], total: Array.isArray(data) ? data.length : 0, page: Number(url.searchParams.get('page')), page_size: Number(url.searchParams.get('page_size')) || 30 };
    if (url.pathname.endsWith('/sync')) data = { revision: 1 };
    if (url.pathname.endsWith('/stats')) data = { todayIn: 0, todayOut: 0, totalProducts: 0, totalStock: 0, lowStock: 0, totalValue: 0, totalReceivable: 0, totalPayable: 0 };
    if (url.pathname.includes('dimensions')) data = { customers: [], inactiveCustomerNames: [], schemaVersion: 1, revision: 0, theme: {} };
    if (url.pathname.endsWith('/print-notes')) data = { items: [], total: 0, page: 1, page_size: 30 };
    return route.fulfill({
      status: request.method() === 'OPTIONS' ? 204 : 200,
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' },
      contentType: 'application/json',
      body: request.method() === 'OPTIONS' ? '' : JSON.stringify({ success: true, data })
    });
  });
  return writes;
}

async function touchDrag(page, { x, y, dx, dy = 0 }) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8, id: 1 }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
}

async function mouseDrag(page, target, dx, dy = 0) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  assert.ok(box, 'The drag target must be visible');
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

module.exports = { serveWeb, isolateBusinessAPI, touchDrag, mouseDrag };
