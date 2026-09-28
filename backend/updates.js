// App 热更新服务端：设备事件日志（JSONL 追加写入）+ 统计聚合
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'update-log.jsonl');
const MANIFEST_PATH = path.join(__dirname, 'public', 'appupdate', 'manifest.json');
const RECENT_MIN = 1;
const RECENT_MAX = 200;
const MANIFEST_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MANIFEST_URL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const CHECK_PLATFORMS = new Set(['ios', 'android', 'windows', 'electron', 'web', 'native', 'unknown']);


// 客户端可上报的事件类型
const REPORT_EVENTS = ['download_attempt', 'downloaded', 'download_failed', 'pending_restart', 'installed', 'updated_auto'];

function clientIp(req) {
  return req.warehouseClientIp || req.ip || req.socket.remoteAddress || '';
}

function sanitizeLogMessage(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(password|passwd|token|secret|api[_-]?key|authorization)\s*([=:])\s*([^&\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, '[PATH]')
    .replace(/(^|[\s("'=])\/(?:home|root|opt|var|etc|tmp|Users|mnt)\/[^\s"'<>]+/g, '$1[PATH]')
    .replace(/\b(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/gi, '$1?[REDACTED]')
    .slice(0, 500);
}

// 追加一条事件日志（一行一个 JSON，并发安全、无需重写全文件）
function logEvent(e) {
  const rec = {
    ts: Date.now(),
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    ip: e.ip || '',
    device_id: e.device_id || '',
    platform: e.platform || '',
    native_version: e.native_version || '',
    current: e.current || '',
    event: e.event,
    from_version: e.from_version || '',
    to_version: e.to_version || '',
    message: sanitizeLogMessage(e.message)
  };
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n', 'utf-8');
  } catch (err) {
    console.error('[热更新] 日志写入失败:', err.message);
  }
  const tag = {
    download_attempt: '开始下载更新包',
    check: '检查更新',
    manifest_fetch: '拉取清单(旧版)',
    zip_download: '下载更新包',
    downloaded: '下载完成',
    download_failed: '下载失败',
    pending_restart: '待重启生效',
    installed: '更新已生效',
    updated_auto: '自动更新已生效'
  }[rec.event] || rec.event;
  console.log(`[热更新] ${rec.time} ${tag} | ${rec.platform || '?'} | 当前:${rec.current || '?'} -> ${rec.to_version || ''} | ${rec.ip} | ${rec.device_id || '未知设备'}${rec.message ? ' | ' + rec.message : ''}`);
  return rec;
}

function readEvents() {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    return fs.readFileSync(LOG_PATH, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

function readManifest() {
  try {
    // PowerShell 写入的 UTF-8 可能带 BOM，JSON.parse 会报错，先剥掉
    const txt = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    // 剥掉 UTF-8 BOM（PowerShell 写文件常带），否则 JSON.parse 报错
    const clean = txt.charCodeAt(0) === 0xFEFF ? txt.slice(1) : txt;
    return validateManifest(JSON.parse(clean));
  } catch (e) {
    console.error('[热更新] manifest 读取失败:', e.message);
    return null;
  }
}

// A malformed or path-traversing manifest must never be treated as an update.
// The package script emits sha256/integrity; older manifests may omit those
// optional fields, but when present they must agree exactly.
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest ????');
  if (typeof manifest.version !== 'string' || !MANIFEST_VERSION.test(manifest.version)) throw new Error('manifest.version ????');
  if (typeof manifest.url !== 'string' || !MANIFEST_URL.test(manifest.url) || manifest.url.includes('..') || manifest.url.includes('\\')) throw new Error('manifest.url ????');
  for (const [field, limit] of [['publishedAt', 64], ['releaseNotes', 2000]]) {
    if (manifest[field] !== undefined && (typeof manifest[field] !== 'string' || manifest[field].length > limit || /[\u0000-\u001f\u007f]/.test(manifest[field]))) throw new Error(`manifest.${field} ????`);
  }
  if (manifest.forceUpdate !== undefined && typeof manifest.forceUpdate !== 'boolean') throw new Error('manifest.forceUpdate ????');
  if (manifest.minNativeVersion !== undefined && manifest.minNativeVersion !== null &&
    (typeof manifest.minNativeVersion !== 'string' || !MANIFEST_VERSION.test(manifest.minNativeVersion))) throw new Error('manifest.minNativeVersion ????');
  const integrityFields = [manifest.sha256, manifest.size, manifest.integrity].filter(value => value !== undefined).length;
  if (integrityFields !== 0 && integrityFields !== 3) throw new Error('manifest ??????????? sha256?size ? integrity');
  if (manifest.sha256 !== undefined && (typeof manifest.sha256 !== 'string' || !SHA256.test(manifest.sha256))) throw new Error('manifest.sha256 ????');
  if (manifest.size !== undefined && (!Number.isSafeInteger(manifest.size) || manifest.size <= 0)) throw new Error('manifest.size ????');
  let safeIntegrity;
  if (manifest.integrity !== undefined) {
    if (!manifest.integrity || typeof manifest.integrity !== 'object' || Array.isArray(manifest.integrity) || manifest.integrity.algorithm !== 'sha256' || !SHA256.test(String(manifest.integrity.value || ''))) throw new Error('manifest.integrity ????');
    if (manifest.integrity.value.toLowerCase() !== manifest.sha256.toLowerCase()) throw new Error('manifest ?????????');
    safeIntegrity = { algorithm: 'sha256', value: manifest.integrity.value.toLowerCase() };
  }
  // Expose only supported integrity fields; arbitrary nested manifest fields
  // must not leak through update-check or stats response serializers.
  return { ...manifest, ...(safeIntegrity ? { integrity: safeIntegrity } : {}) };
}

// The maintenance dashboard accepts a bounded number of recent events.  Do not
// silently coerce malformed query values with Number(... ) || 50: a typo such as
// recent=0, an array, or a huge value must be rejected before reading the log.
function parseRecent(value) {
  if (value === undefined) return 50;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text) || text.length > 3) {
    throw Object.assign(new Error(`recent 必须是 ${RECENT_MIN} 至 ${RECENT_MAX} 的整数`), { status: 400 });
  }
  const recent = Number(text);
  if (!Number.isSafeInteger(recent) || recent < RECENT_MIN || recent > RECENT_MAX) {
    throw Object.assign(new Error(`recent 必须是 ${RECENT_MIN} 至 ${RECENT_MAX} 的整数`), { status: 400 });
  }
  return recent;
}

// 聚合统计：设备列表、版本分布、事件计数、安装/失败数、最近事件
function parseCheckQuery(query = {}) {
  const readText = (name, max = 128) => {
    const value = query[name];
    if (value === undefined || value === '') return '';
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f<>\"'`]/.test(value)) throw Object.assign(new Error(`${name} ??????`), { status: 400 });
    return value;
  };
  const device_id = readText('device_id');
  const platform = readText('platform', 32).toLowerCase();
  const native_version = readText('native_version', 64);
  const current = readText('current', 64);
  const cacheBust = query.t;
  if (cacheBust !== undefined && (typeof cacheBust !== 'string' || !/^\d{1,16}$/.test(cacheBust))) throw Object.assign(new Error('t ??????'), { status: 400 });
  if (platform && !CHECK_PLATFORMS.has(platform)) throw Object.assign(new Error('platform ???????'), { status: 400 });
  return { device_id, platform, native_version, current };
}

function parseReportPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('??????? JSON ??'), { status: 400 });
  const event = body.event;
  if (typeof event !== 'string' || !REPORT_EVENTS.includes(event)) throw Object.assign(new Error(`????: ${String(event || '')}`), { status: 400 });
  const readText = (name, max = 128) => {
    const value = body[name];
    if (value === undefined || value === '') return '';
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f<>\"'`]/.test(value)) throw Object.assign(new Error(`${name} ??????`), { status: 400 });
    return value;
  };
  const device_id = readText('device_id', 128);
  const platform = readText('platform', 32).toLowerCase();
  if (platform && !CHECK_PLATFORMS.has(platform)) throw Object.assign(new Error('platform ???????'), { status: 400 });
  return {
    event,
    device_id,
    platform,
    native_version: readText('native_version', 64),
    current: readText('current', 64),
    from_version: readText('from_version', 64),
    to_version: readText('to_version', 64),
    message: readText('message', 500)
  };
}

function parseDownloadsQuery(query = {}) {
  const keys = Object.keys(query);
  for (const key of keys) {
    if (key !== 't') throw Object.assign(new Error(`查询参数 ${key} 不受支持`), { status: 400 });
  }
  const value = query.t;
  if (value !== undefined && (typeof value !== 'string' || !/^\d{1,16}$/.test(value))) {
    throw Object.assign(new Error('t 参数格式无效'), { status: 400 });
  }
  return value || '';
}

function stats(recentN = 50) {
  // Keep direct service callers under the same bounds as the HTTP route.
  // This prevents an internal caller from bypassing recent's 1..200 contract.
  recentN = parseRecent(recentN);
  const evs = readEvents();
  const devices = new Map();
  const eventCounts = {};
  let installs = 0, failures = 0;

  for (const e of evs) {
    eventCounts[e.event] = (eventCounts[e.event] || 0) + 1;
    if (e.event === 'installed') installs++;
    if (e.event === 'download_failed') failures++;
    if (e.device_id) {
      const d = devices.get(e.device_id) || {
        device_id: e.device_id, platform: '', native_version: '',
        current: '', ip: '', lastSeen: 0
      };
      if (e.platform) d.platform = e.platform;
      if (e.native_version) d.native_version = e.native_version;
      if (e.ts >= d.lastSeen) {
        d.lastSeen = e.ts;
        d.ip = e.ip || d.ip;
        if (e.current) d.current = e.current;
      }
      devices.set(e.device_id, d);
    }
  }

  const versionDist = {};
  for (const d of devices.values()) {
    const v = d.current || 'unknown';
    versionDist[v] = (versionDist[v] || 0) + 1;
  }

  const m = readManifest();
  const latest = m ? {
    version: m.version,
    publishedAt: m.publishedAt || '',
    url: m.url || 'www.zip',
    ...(m.sha256 ? { sha256: m.sha256 } : {}),
    ...(Number.isSafeInteger(m.size) ? { size: m.size } : {}),
    ...(m.integrity ? { integrity: m.integrity } : {})
  } : null;
  return {
    latest,
    totalEvents: evs.length,
    deviceCount: devices.size,
    eventCounts,
    versionDistribution: versionDist,
    installs,
    failures,
    devices: Array.from(devices.values()).sort((a, b) => b.lastSeen - a.lastSeen),
    recent: evs.slice(-recentN).reverse()
  };
}

module.exports = { logEvent, readEvents, readManifest, validateManifest, stats, parseRecent, parseCheckQuery, parseReportPayload, parseDownloadsQuery, sanitizeLogMessage, clientIp, REPORT_EVENTS, LOG_PATH, RECENT_MIN, RECENT_MAX };
