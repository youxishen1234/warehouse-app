// 无扫码版仓库系统 - 后端服务 (端口 4000，监听所有网卡)
const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const proxyaddr = require('proxy-addr');
const db = require('./db');
const updates = require('./updates');
const installGracefulShutdown = require('./graceful-shutdown');
const { consumeRateLimit } = require('./rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const APP_DOWNLOADS_RATE_LIMIT = Math.max(2, Math.min(1000, Number(process.env.WAREHOUSE_APP_DOWNLOADS_RATE_LIMIT) || 20));
const appDownloadsBuckets = new Map();
const appUpdateReportBuckets = new Map();
const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'nonce-sg-bootstrap'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://youxishen.online http://localhost:* https://localhost:* http://127.0.0.1:*; font-src 'self' data:; connect-src 'self' https://youxishen.online capacitor://localhost http://localhost:* https://localhost:* http://127.0.0.1:*; worker-src 'self' blob:;";

const trustedProxyRules = String(process.env.WAREHOUSE_TRUSTED_PROXY_CIDRS || '127.0.0.1/32,::1/128')
  .split(',').map(value => value.trim()).filter(Boolean);
let isTrustedProxy;
try { isTrustedProxy = proxyaddr.compile(trustedProxyRules); }
catch (error) { isTrustedProxy = proxyaddr.compile(['127.0.0.1/32', '::1/128']); }
const allowedOrigins = new Set(String(process.env.WAREHOUSE_ALLOWED_ORIGINS || 'https://youxishen.online,capacitor://localhost,https://localhost,http://localhost')
  .split(',').map(value => value.trim()).filter(Boolean));
function validForwardedIp(value) {
  const candidate = String(value || '').split(',')[0].trim().replace(/^\[|\]$/g, '');
  return require('node:net').isIP(candidate) ? candidate : '';
}
function allowedOrigin(origin) {
  return allowedOrigins.has(origin) || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);
}
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  if (!isTrustedProxy(remote)) return remote || req.ip || '';
  return validForwardedIp(req.get('CF-Connecting-IP')) || validForwardedIp(req.get('X-Forwarded-For')) || req.ip || remote;
}
function allowAppDownloads(req) {
  const key = String(req.warehouseClientIp || clientIp(req) || 'unknown');
  return consumeRateLimit(appDownloadsBuckets, key, { limit: APP_DOWNLOADS_RATE_LIMIT });
}
function allowAppUpdateReport(req) {
  const limit = Math.max(2, Math.min(1000, Number(process.env.WAREHOUSE_APPUPDATE_REPORT_RATE_LIMIT) || 60));
  const key = `${String(req.warehouseClientIp || clientIp(req) || 'unknown')}:${String(req.get('X-Warehouse-Device') || 'unknown').slice(0, 80)}`;
  return consumeRateLimit(appUpdateReportBuckets, key, { limit });
}

app.disable('x-powered-by');

app.set('trust proxy', ip => isTrustedProxy(ip));
// 原生 Capacitor App 的页面来源是 capacitor://localhost；为 API 和更新包允许跨域访问。
app.use((req, res, next) => {
  const requestId = req.get('X-Request-Id') || require('crypto').randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  req.warehouseClientIp = clientIp(req);
  const origin = req.get('Origin');
  if (origin && allowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, If-Match, If-None-Match, X-Request-Id, X-Warehouse-Device');
    res.setHeader('Access-Control-Expose-Headers', 'X-Warehouse-Revision');
    res.setHeader('Vary', 'Origin');
  } else if (origin && req.method === 'OPTIONS') {
    return res.status(403).json({ success: false, message: '\u8bf7\u6c42\u6765\u6e90\u4e0d\u5728\u5141\u8bb8\u540d\u5355\u5185' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const BODY_LIMITS = Object.freeze({ general: 1024 * 1024, imageJson: 2.5 * 1024 * 1024, imageDecoded: 2 * 1024 * 1024, backup: 5 * 1024 * 1024 });
// Parse each large-body route with its own ceiling before the general parser.
// The JSON envelope is capped at the documented 2.5 MiB; decoded image bytes
// retain the separate 2 MiB business limit in the route handler.
app.use('/api/products/:id/image', express.json({ limit: `${BODY_LIMITS.imageJson}b` }));
app.use('/api/backup', express.json({ limit: `${BODY_LIMITS.backup}b` }));
app.use('/api', express.json({ limit: `${BODY_LIMITS.general}b` }));
app.use('/api', require('./team')(db));

// 热更新静态文件访问日志（旧版 App 直接拉 manifest.json / www.zip）
app.use('/appupdate', (req, res, next) => {
  // 注意：req.path 必须在进入时捕获——finish 触发时 Express 已把 req.url 还原成完整路径
  const file = req.path.replace(/^\//, '');
  const isUpdateFile = file === 'manifest.json' || file === 'www.zip';
  if (req.method === 'GET' && isUpdateFile) res.set('Cache-Control', 'no-store');
  res.on('finish', () => {
    if (req.method !== 'GET' || !isUpdateFile) return;
    updates.logEvent({
      event: file === 'manifest.json' ? 'manifest_fetch' : 'zip_download',
      ip: updates.clientIp(req),
      message: res.statusCode + ' ' + (res.getHeader('content-length') || 0) + 'B'
    });
  });
  next();
});


// 为 IPA 文件添加下载头，让浏览器触发下载而不是黑屏
// ??????????? IP????????????????????
function sendPackageDownload(req, res, filePath, fileName, platform) {
  const manifest = updates.readManifest();
  const startedAt = Date.now();
  res.setHeader('Content-Disposition', `attachment; filename=\"${fileName}\"`);
  res.on('finish', () => {
    updates.logEvent({
      event: 'package_download',
      ip: updates.clientIp(req),
      device_id: req.get('X-Warehouse-Device') || '',
      platform,
      current: req.query.current || '',
      to_version: manifest?.version || '',
      message: `${fileName} ${res.statusCode} ${res.getHeader('content-length') || 0}B ${Date.now() - startedAt}ms`
    });
  });
  res.sendFile(filePath, error => {
    if (!error) return;
    if (res.headersSent) return res.destroy(error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status >= 500) console.error('[api-error]', JSON.stringify({ requestId: res.get('X-Request-Id') || '', method: req.method, path: req.path, status, message: error.message || String(error) }));
    res.status(status).type('application/json').json({ success: false, message: status === 404 ? '安装包不存在或暂不可用' : '安装包暂时无法下载，请稍后重试' });
  });
}

app.get('/shuguang.ipa', (req, res) => {
  sendPackageDownload(req, res, path.join(__dirname, 'public', 'shuguang.ipa'), 'shuguang.ipa', 'ios');
});

app.get('/download/shuguang.ipa', (req, res) => {
  sendPackageDownload(req, res, path.join(__dirname, 'public', 'download', 'shuguang.ipa'), 'shuguang.ipa', 'ios');
});

app.use(express.static(path.join(__dirname, 'public')));

// ============ App 热更新服务 ============
// 版本检查：客户端启动时带 设备ID/平台/原生版本/当前热更版本 来询
app.get('/api/appupdate/check', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const q = updates.parseCheckQuery(req.query);
    const m = updates.readManifest();
    if (!m || !m.version) return res.status(404).json({ success: false, message: '暂无更新包' });
    updates.logEvent({
      event: 'check',
      ip: updates.clientIp(req),
      device_id: q.device_id || '',
      platform: q.platform || '',
      native_version: q.native_version || '',
      current: q.current || ''
    });
    res.json({
      success: true,
      data: {
        version: m.version,
        url: m.url || 'www.zip',
        publishedAt: m.publishedAt || '',
        releaseNotes: m.releaseNotes || '',
        // Integrity metadata is public release information; do not expose
        // filesystem paths or server credentials through the check endpoint.
        ...(m.sha256 ? { sha256: m.sha256 } : {}),
        ...(Number.isSafeInteger(m.size) ? { size: m.size } : {}),
        ...(m.integrity ? { integrity: m.integrity } : {}),
        forceUpdate: !!m.forceUpdate,
        minNativeVersion: m.minNativeVersion || null,
        update: (q.current || '') !== m.version
      }
    });
  } catch (e) {
    const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
    if (status >= 500) console.error('[api-error]', JSON.stringify({ requestId: res.get('X-Request-Id') || '', method: req.method, path: req.path, status, message: e?.message || String(e) }));
    res.status(status).json({ success: false, message: status < 500 ? e.message : '???????????' });
  }
});

// 事件上报：downloaded / download_failed / pending_restart / installed
app.post('/api/appupdate/report', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!allowAppUpdateReport(req)) {
    res.set('Retry-After', '60');
    return res.status(429).json({ success: false, message: '热更新事件上报过于频繁，请稍后重试' });
  }
  try {
    const b = updates.parseReportPayload(req.body);
    updates.logEvent({
      event: b.event,
      ip: updates.clientIp(req),
      device_id: b.device_id,
      platform: b.platform,
      native_version: b.native_version,
      current: b.current,
      from_version: b.from_version,
      to_version: b.to_version,
      message: b.message
    });
    res.json({ success: true });
  } catch (e) {
    const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
    if (status >= 500) console.error('[api-error]', JSON.stringify({ requestId: res.get('X-Request-Id') || '', method: req.method, path: req.path, status, message: e?.message || String(e) }));
    res.status(status).json({ success: false, message: status < 500 ? e.message : '???????????' });
  }
});

// ???????????????? App ????????
app.get('/api/app/downloads', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!allowAppDownloads(req)) {
    res.set('Retry-After', '60');
    return res.status(429).json({ success: false, message: '下载信息请求过于频繁，请稍后重试' });
  }
  try {
    updates.parseDownloadsQuery(req.query);
    const fs = require('fs');
    const m = updates.readManifest();
    const publicDir = path.join(__dirname, 'public');
    const has = f => fs.existsSync(path.join(publicDir, f));
    const origin = `${req.protocol}://${req.get('host')}`;
    const metadata = f => {
      if (!has(f)) return { url: null, size: null, sha256: null };
      const bytes = fs.readFileSync(path.join(publicDir, f));
      return { url: `${origin}/${f}`, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    };
    const ipa = metadata('shuguang.ipa');
    const apk = metadata('shuguang.apk');
    res.json({
      success: true,
      data: {
        hotVersion: m && m.version ? m.version : null,
        publishedAt: m && m.publishedAt ? m.publishedAt : '',
        releaseNotes: m && m.releaseNotes ? m.releaseNotes : '',
        ipa: ipa.url ? `${origin}/shuguang.ipa` : null,
        ipaSize: ipa.size,
        ipaSha256: ipa.sha256,
        apk: apk.url ? `${origin}/shuguang.apk` : null,
        apkSize: apk.size,
        apkSha256: apk.sha256
      }
    });
  } catch (e) {
    const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
    if (status >= 500) console.error('[api-error]', JSON.stringify({ requestId: res.get('X-Request-Id') || '', method: req.method, path: req.path, status, message: e?.message || String(e) }));
    res.status(status).json({ success: false, message: status < 500 ? e.message : '???????????' });
  }
});

function getLanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// 统一处理请求体解析错误，避免 Express 默认返回 HTML 或堆栈。
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    const imageRequest = /^\/api\/products\/\d+\/image\/?$/.test(String(req.path || ''));
    const message = imageRequest ? '图片请求内容过大，请压缩图片后重试' : '请求内容过大，请减少提交内容后重试';
    return res.status(413).json({ success: false, message });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) return res.status(400).json({ success: false, message: '请求数据格式错误，请检查 JSON 内容' });
  if (req.path.startsWith('/api')) return res.status(err?.status || 500).json({ success: false, message: err?.status ? (err.message || '请求失败') : '服务器暂时无法处理请求' });
  next(err);
});

if (require.main === module) {
  startServer();
}

function startServer() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    const lanIP = getLanIP();
    const actualPort = server.address()?.port || PORT;
    console.log(`\n  ============================================`);
    console.log(`  仓库出入库管理系统（无扫码版）已启动`);
    console.log(`  电脑本地: http://localhost:${actualPort}`);
    console.log(`  手机访问: http://${lanIP}:${actualPort}  （手机与电脑连同一WiFi）`);
    console.log(`  操作方式: 从下拉列表选择商品即可出入库`);
    console.log(`  ============================================\n`);
    console.log(`[server] listening on ${actualPort}`);
  });
  installGracefulShutdown(server);
  return server;
}

module.exports = app;
module.exports.startServer = startServer;
