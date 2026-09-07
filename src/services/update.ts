import Taro from '@tarojs/taro';
import { getBaseUrl } from '@/services/request';

// ============================================
// App 内「检查更新」：点击即检查，发现新版本自动下载并在下次启动时应用
// 仅原生 App（Capacitor）环境可用；浏览器 / 微信里给出提示
// ============================================

interface NativeUpdater {
  current(): Promise<{ id?: string; version?: string; native?: string } | null>;
  download(opts: { url: string; version: string }): Promise<{ id: string; version?: string } | null>;
  set(opts: { id: string }): Promise<{ id?: string; version?: string } | null>;
  next?(opts: { id: string }): Promise<boolean>;
}

function getUpdater(): NativeUpdater | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as any).Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
  return (cap.Plugins && cap.Plugins.CapacitorUpdater) || null;
}

/** 设备唯一标识（与 index.html 更新脚本一致，用于服务器统计） */
function deviceId(): string {
  try {
    let did = localStorage.getItem('sg_did');
    if (!did) {
      did = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('sg_did', did);
    }
    return did;
  } catch (e) {
    return '';
  }
}

function platform(): string {
  try {
    const cap = (window as any).Capacitor;
    return (cap && cap.getPlatform && cap.getPlatform()) || 'native';
  } catch (e) {
    return 'native';
  }
}

// 上报更新事件到服务器（fire-and-forget，失败静默）
function report(ev: string, fromVersion: string, toVersion: string, message?: string) {
  try {
    fetch(`${getBaseUrl()}/api/appupdate/report?t=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: deviceId(),
        platform: platform(),
        event: ev,
        current: fromVersion,
        to_version: toVersion,
        message: message || ''
      })
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}

export interface CheckUpdateResult {
  hasUpdate: boolean;
  message: string;
}

/** 检查更新：有新版则自动下载并立即应用（无需手动重启） */
export async function checkAndUpdate(): Promise<CheckUpdateResult> {
  const tu = getUpdater();
  if (!tu) {
    return { hasUpdate: false, message: '请下载 App 后使用检查更新' };
  }

  const base = getBaseUrl().replace(/\/+$/, '');
  const now = Date.now();

  // 当前运行的版本（首次安装为 builtin）
  let cur = 'builtin';
  try {
    const c = await tu.current();
    if (c && c.version) cur = c.version;
  } catch (e) { /* ignore */ }

  // 1) 检查是否有新版本（优先 check 接口，失败回退 manifest.json）
  let info: { version?: string; url?: string } | null = null;
  try {
    const res = await Taro.request({
      url: `${base}/api/appupdate/check?current=${encodeURIComponent(cur)}&t=${now}`,
      timeout: 10000
    });
    const body = res.data as any;
    if (res.statusCode === 200 && body && body.success && body.data && body.data.version) {
      info = body.data;
    }
  } catch (e) { /* ignore */ }

  if (!info) {
    try {
      const res = await Taro.request({
        url: `${base}/appupdate/manifest.json?t=${now}`,
        timeout: 10000
      });
      const body = res.data as any;
      if (res.statusCode === 200 && body && body.version) info = body;
    } catch (e) { /* ignore */ }
  }

  const latest = info?.version;
  if (!latest) {
    return { hasUpdate: false, message: '获取更新信息失败，请检查服务器地址或网络' };
  }
  if (latest === cur) {
    console.log(`[UPDATE] 已是最新版本 v${latest}`);
    return { hasUpdate: false, message: `已是最新版本 v${latest}` };
  }

  console.log(`[UPDATE] 发现新版本 v${cur} -> v${latest}，开始自动更新…`);

  // 2) 下载更新包
  let bid = '';
  const downloadUrl = `${base}/appupdate/${(info.url || 'www.zip').replace(/^\//, '')}?t=${now}`;
  report('download_attempt', cur, latest, downloadUrl);
  try {
    const res = await tu.download({
      url: downloadUrl,
      version: latest
    });
    bid = (res && res.id) || '';
  } catch (e: any) {
    report('download_failed', cur, latest, String(e?.message || 'download error'));
    return { hasUpdate: true, message: '更新包下载失败，请检查网络后重试' };
  }
  if (!bid) {
    report('download_failed', cur, latest, 'empty bundle id');
    return { hasUpdate: true, message: '更新包下载失败，请稍后重试' };
  }
  report('downloaded', cur, latest);

  // 3) iOS 只在下次启动时切换更新包，避免 WebView 运行中切包闪退。
  try {
    const nx = tu.next ? await tu.next({ id: bid }) : null;
    if (nx !== null) {
      report('pending_restart', cur, latest);
      return { hasUpdate: true, message: '更新已下载，请关闭后重新打开 App 生效' };
    }
  } catch (e) { /* ignore */ }

  return { hasUpdate: true, message: '更新已下载，请关闭后重新打开 App 生效' };
}