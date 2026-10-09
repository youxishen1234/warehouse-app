const fs = require('node:fs');
const path = require('node:path');
const express = require('../backend/node_modules/express');
const { randomBytes } = require('node:crypto');
const { createPrintService, authorizeLocalPrint } = require('./dot-matrix-native.cjs');

const root = path.resolve(process.env.DOT_MATRIX_PREVIEW_ROOT || path.join(__dirname, '../release/dot-matrix-web'));
const port = Number(process.env.PRINT_PREVIEW_PORT || 4316);
const app = express();
const printToken = randomBytes(32).toString('hex');
const printers = createPrintService();
const session = { token: 'local-print-preview', user: { id: 'print-preview', username: '预览用户', role: 'viewer' } };
const timestamp = new Date('2026-10-03T10:00:00+08:00').getTime();
const record = (id, number, changes = {}) => ({
  id, type: 'out', product_id: 1000 + id, product_name: '五层瓦楞纸箱', specification: '40 × 30 × 20 cm',
  quantity: 100, unit: '个', unit_price: 3.5, amount: 350, operator: '示例经手人',
  customer_id: 1, customer_name: '示例客户 · 华兴包装', outbound_no: number, order_no: 'DD-DEMO-001',
  remark: '示例数据，仅用于预览', created_at: timestamp, ...changes,
});
const records = [
  record(1, 'CK-DEMO-001'),
  record(2, 'CK-DEMO-001', { product_name: '三层瓦楞纸箱', specification: '30 × 20 × 15 cm', quantity: 200, unit_price: 2.2, amount: 440 }),
  record(3, 'CK-DEMO-001', { product_name: '加厚包装箱', specification: '60 × 40 × 40 cm', quantity: 50, unit_price: 8, amount: 400 }),
  ...Array.from({ length: 12 }, (_, i) => record(11 + i, 'CK-DEMO-002', {
    customer_id: 2, customer_name: '示例客户 · 多页单据', product_name: `包装纸箱 ${i + 1}`,
    specification: `${30 + i} × 25 × 20 cm`, remark: i === 4 ? '请核对外箱尺寸，收货时检查数量与包装是否完好。' : '多页打印示例',
  })),
  { id: 101, type: 'in', product_id: 201, product_name: '五层瓦楞纸板', specification: '120 × 80 cm', quantity: 500, unit: '张', unit_price: 2.5, amount: 1250, supplier_id: 3, supplier_name: '示例供应商 · 恒盛纸业', operator: '示例验收人', remark: '入库凭证预览', created_at: timestamp },
];

// This adapter exists only in the preview server; the built application stays unchanged.
const adapter = `(() => {
  const map = value => { const url = new URL(value, location.href); return url.pathname.startsWith('/api/') ? location.origin + url.pathname + url.search : value; };
  const originalFetch = window.fetch.bind(window);
  const callPrintService = async (endpoint, data) => {
    let response;
    try {
      response = await originalFetch('/__local-print/' + endpoint, { method: data ? 'POST' : 'GET',
        headers: { 'X-Warehouse-Print-Token': ${JSON.stringify(printToken)}, ...(data ? { 'Content-Type': 'application/json' } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}) });
    } catch (_) { throw Object.assign(new Error('本机打印连接中断，请先核对打印队列；重试会查询同一任务。'), { safeToRetry: false }); }
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message || '本机打印服务无法连接，请刷新页面'), { safeToRetry: result.safeToRetry === true });
    return result;
  };
  Object.defineProperty(window, 'warehouseLocalPrint', { value: Object.freeze({ version: 1,
    listPrinters: () => callPrintService('printers'), print: job => callPrintService('jobs', job) }) });
  window.fetch = (input, init) => originalFetch(input instanceof Request ? new Request(map(input.url), input) : map(String(input)), init);
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) { return originalOpen.call(this, method, map(String(url)), ...args); };
  localStorage.setItem('warehouse_session_v1', JSON.stringify({ data: ${JSON.stringify(session)} }));
})();`;

app.disable('x-powered-by');
app.use((_, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
app.use((request, response, next) => {
  if (!authorizeLocalPrint(request, { port, token: printToken }, false)) return response.status(403).json({ message: '仅允许本机打印页面访问' });
  next();
});
app.get('/__preview/health', (_, response) => response.json({ preview: 'dot-matrix', ready: true }));
app.get('/__print-preview.js', (_, response) => response.type('application/javascript').send(adapter));
app.use('/__local-print', (request, response, next) => {
  if (!authorizeLocalPrint(request, { port, token: printToken })) return response.status(403).json({ message: '打印连接已过期，请刷新页面', safeToRetry: false });
  next();
});
app.get('/__local-print/printers', async (_, response) => {
  try { response.json(await printers.list()); }
  catch (error) { response.status(503).json({ message: error.message, safeToRetry: true }); }
});
app.post('/__local-print/jobs', express.json({ limit: '1mb' }), async (request, response) => {
  try { response.json(await printers.submit(request.body)); }
  catch (error) { response.status(400).json({ message: error.message, code: error.code, safeToRetry: error.safeToRetry === true }); }
});
app.use('/__local-print', (error, _, response, next) => {
  if (!error) return next();
  response.status(400).json({ message: '打印资料格式错误或超过大小限制', safeToRetry: true });
});
app.use('/api', (request, response) => {
  response.set('X-Warehouse-Revision', '1');
  const ok = data => response.json({ success: true, data });
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  if (request.path === '/auth/guest') return ok(session);
  if (request.method !== 'GET') return response.status(403).json({ success: false, message: '这是只读预览，不能修改业务数据' });
  if (request.path === '/sync') return ok({ revision: 1 });
  if (request.path === '/health') return ok({ status: 'ok', preview: true });
  if (request.path === '/transactions') {
    let items = records.filter(item => !request.query.type || item.type === request.query.type);
    if (request.query.customer_id) items = items.filter(item => item.customer_id === Number(request.query.customer_id));
    if (request.query.supplier_id) items = items.filter(item => item.supplier_id === Number(request.query.supplier_id));
    if (request.query.page) {
      const page = Math.max(1, Number(request.query.page) || 1);
      const pageSize = Math.max(1, Math.min(200, Number(request.query.page_size) || 200));
      return ok({ items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, page_size: pageSize });
    }
    return ok(items);
  }
  if (request.path === '/stats') return ok({ todayIn: 0, todayOut: 0, totalProducts: 0, lowStock: 0, totalValue: 0 });
  return ok([]);
});
app.get('/', (_, response) => response.redirect('/index.html#/pages/print-center/index?transaction_id=1'));
app.get(['/index.html', '/pages/*'], (_, response) => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace('<title>曙光</title>', '<title>针式打印 · 浏览器预览</title>')
    .replace(/connect-src [^;]+;/, "connect-src 'self';")
    .replace('<head>', '<head><script src="/__print-preview.js"></script>')
    .replace('</head>', '<style>#print-preview-notice{position:fixed;left:14px;bottom:12px;z-index:9999;padding:7px 12px;border-radius:18px;border:1px solid #ffffff24;background:#152b3ee8;color:#bad6ec;font:12px/1.5 system-ui,sans-serif;pointer-events:none}@media print{#print-preview-notice{display:none}}</style></head>')
    .replace('</body>', '<aside id="print-preview-notice">预览模式 · 示例数据</aside></body>');
  response.type('html').send(html);
});
app.use(express.static(root));
app.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(path.resolve(__dirname, '../release/dot-matrix-preview.pid'), String(process.pid));
  console.log(`Print preview: http://127.0.0.1:${port}/`);
});
