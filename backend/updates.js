// App 热更新服务端：设备事件日志（JSONL 追加写入）+ 统计聚合
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'update-log.jsonl');
const MANIFEST_PATH = path.join(__dirname, 'public', 'appupdate', 'manifest.json');

// 客户端可上报的事件类型
const REPORT_EVENTS = ['downloaded', 'download_failed', 'pending_restart', 'installed', 'updated_auto'];

function clientIp(req) {
  const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '';
  return String(fwd).split(',')[0].trim() || req.ip || req.socket.remoteAddress || '';
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
    message: e.message || ''
  };
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n', 'utf-8');
  } catch (err) {
    console.error('[热更新] 日志写入失败:', err.message);
  }
  const tag = {
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
    return JSON.parse(clean);
  } catch (e) {
    console.error('[热更新] manifest 读取失败:', e.message);
    return null;
  }
}

// 聚合统计：设备列表、版本分布、事件计数、安装/失败数、最近事件
function stats(recentN = 50) {
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
  return {
    latest: m ? { version: m.version, publishedAt: m.publishedAt || '', url: m.url || 'www.zip' } : null,
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

module.exports = { logEvent, readEvents, readManifest, stats, clientIp, REPORT_EVENTS, LOG_PATH };
