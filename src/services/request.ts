import Taro from '@tarojs/taro';
import { session, setSession, TEAM_ORIGIN, PUBLIC_ORIGIN, sessionOrigin, watchSession, deviceId } from './session';
import { refreshSharedData } from './shared-refresh';

// 后端 API 基地址，统一指向服务器
const DEFAULT_BASE = 'http://152.136.100.200';
const FALLBACK_BASE = 'http://152.136.100.200';
const API_ORIGINS = [FALLBACK_BASE, PUBLIC_ORIGIN];
let activeApiOrigin = sessionOrigin();

// 用户可在「我的-服务器地址」里修改后端/更新地址，修改后持久化，优先于默认地址
const CUSTOM_BASE_KEY = 'sg_custom_base';

function normalizeBase(url: string): string {
  const value = url.trim();
  if (!value) return '';
  const candidate = /^https?:\/\//i.test(value) ? value : (/^152\.136\.100\.200(?::\d+)?\/?$/.test(value) ? 'http://' : 'https://') + value;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) throw new Error('请输入服务器地址，不要包含下载路径');
  return parsed.origin;
}

function readCustomBase(): string {
  try {
    const v = Taro.getStorageSync(CUSTOM_BASE_KEY);
    if (typeof v !== 'string' || !v.trim()) return '';
    const normalized = normalizeBase(v);
    if (/^http:\/\/152\.136\.100\.200:4000$/i.test(normalized)) {
      const migrated = 'http://152.136.100.200';
      Taro.setStorageSync(CUSTOM_BASE_KEY, migrated);
      return migrated;
    }
    return normalized;
  } catch (e) { return ''; }
}

let baseUrl = readCustomBase();

/** 当前生效的后端地址（用户可在 App 内修改） */
export function getBaseUrl(): string {
  return baseUrl || sessionOrigin();
}

/** 修改后端/更新地址：空值恢复默认；清空旧缓存立即生效 */
export function setBaseUrl(url: string): void {
  if (url && ![TEAM_ORIGIN, PUBLIC_ORIGIN].includes(normalizeBase(url))) throw new Error('地址必须是共享仓库服务器地址');
  const trimmed = normalizeBase(url);
  if (trimmed) {
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new Error('地址需以 http:// 或 https:// 开头');
    }
    baseUrl = trimmed;
    try { Taro.setStorageSync(CUSTOM_BASE_KEY, trimmed); } catch (e) { /* ignore */ }
  } else {
    baseUrl = '';
    try { Taro.removeStorageSync(CUSTOM_BASE_KEY); } catch (e) { /* ignore */ }
  }
  // 地址变化后旧缓存不可信，整体清空；退出离线模式等待真实连接结果
  try {
    const idx = readIndex();
    idx.forEach(k => { try { Taro.removeStorageSync(CACHE_PREFIX + k); } catch (e) { /* ignore */ } });
    writeIndex([]);
  } catch (e) { /* ignore */ }
  setOffline(false);
}

// ============================================
// 自动选择可达地址（服务器优先，自定义地址兜底）
// 打开 App 时自动探测：优先服务器地址，必要时再尝试用户自定义地址。
// ============================================

/** 依次探测候选地址，返回第一个可用的；全部失败返回 null */
export async function autoBestBase(): Promise<string | null> {
  const custom = readCustomBase();
  // 去重候选：服务器 → 用户自定义
  const candidates = [TEAM_ORIGIN];
  for (const c of candidates) {
    try {
      const res = await fetchApi('/api/health', 'GET', undefined, {}, 5000);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (c !== getBaseUrl()) {
          // 记住选中的地址（默认隧道存空=恢复默认）；同时清旧缓存、退出离线
          setBaseUrl(c === DEFAULT_BASE ? '' : c);
        } else {
          setOffline(false);
        }
        return c;
      }
    } catch (e) { /* 当前候选不可达，继续下一个 */ }
  }
  return null;
}

// ============================================
// 离线缓存兜底
// 后端不可达（如本地服务未启动 / 穿透地址过期）时，
// 自动读取本地缓存数据，保证 App 照常可用并提示「离线模式」。
// ============================================
const CACHE_PREFIX = 'team_cache_';
const CACHE_INDEX_KEY = CACHE_PREFIX + '__idx';
const CACHE_MAX = 60; // 最多缓存条数（FIFO 淘汰）

let offline = false;
const listeners = new Set<(v: boolean) => void>();

/** 当前是否处于离线模式 */
export function isOffline(): boolean {
  return offline;
}

/** 订阅离线状态变化，返回取消订阅函数 */
export function onOfflineChange(fn: (v: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setOffline(v: boolean) {
  if (offline === v) return;
  offline = v;
  console.log(`[API] offline mode: ${v}`);
  listeners.forEach(fn => {
    try { fn(v); } catch (e) { console.error('[API] offline listener error', e); }
  });
}

function readIndex(): string[] {
  try {
    const v = Taro.getStorageSync(CACHE_INDEX_KEY);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch (e) { return []; }
}

function writeIndex(idx: string[]) {
  try { Taro.setStorageSync(CACHE_INDEX_KEY, idx); } catch (e) { /* 存储已满时忽略 */ }
}

function cacheGet<T>(key: string): T | undefined {
  // Business records must always come from the shared server; only session/device metadata is local.
  return undefined;
}

function cacheSet(key: string, val: unknown) {
  // Do not persist products, customers, suppliers, orders or ledger data on-device.
}

// 写操作成功后，清空列表类接口的旧缓存，保证下次读取刷新
function evictRelated() {
  const prefixes = ['/api/stats', '/api/products', '/api/customers', '/api/suppliers', '/api/transactions', '/api/ledger', '/api/orders'];
  const idx = readIndex();
  const keep = idx.filter(k => !prefixes.some(p => k.includes(p)));
  idx.forEach(k => {
    if (!keep.includes(k)) {
      try { Taro.removeStorageSync(CACHE_PREFIX + k); } catch (e) { /* ignore */ }
    }
  });
  writeIndex(keep);
}

// 网络层错误（iOS WKWebView 的 "load failed"、安卓 request:fail 等）
const NET_RE = /timeout|load failed|request:fail|network|failed to fetch|networkerror|502|503|504/i;
function isNetworkError(e: any): boolean {
  return NET_RE.test(String(e?.message || e?.errMsg || ''));
}

// 把底层网络错误转成中文提示
function friendlyError(e: any): string {
  const raw = String(e?.message || e?.errMsg || '');
  if (/timeout/i.test(raw)) return '连接超时，请检查网络后重试';
  if (NET_RE.test(raw)) return '服务器连接失败，请稍后重试';
  if (/HTTP (\d+)/.test(raw)) return '服务器繁忙，请稍后重试';
  return raw || '网络错误，请稍后重试';
}

// 全局节流：同一时刻只弹一个 toast，避免离线时连续弹窗
let lastToastAt = 0;
function toastOnce(title: string) {
  const now = Date.now();
  if (now - lastToastAt < 3000) return;
  lastToastAt = now;
  Taro.showToast({ title, icon: 'none', duration: 2000 });
}

interface RequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: any;
  header?: Record<string, string>;
}

async function fetchApi(url: string, method: string, data: unknown, headers: Record<string, string>, timeout: number) {
  let lastError: unknown;
  for (const origin of [...new Set([activeApiOrigin, ...API_ORIGINS])]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${origin}${url}`, {
      method,
      cache: 'no-store',
      signal: controller.signal,
      headers,
      body: data === undefined ? undefined : JSON.stringify(data)
      });
      let body: any = null;
      try { body = await response.json(); } catch (error) { /* non JSON errors use the HTTP status below */ }
      if (response.ok || response.status < 500) activeApiOrigin = origin;
      const revision = response.headers.get('X-Warehouse-Revision');
      return { statusCode: response.status, data: body, header: revision ? { 'x-warehouse-revision': revision } : {} };
    } catch (error) { lastError = error; }
    finally { clearTimeout(timer); }
  }
  throw lastError || new Error('网络连接失败');
}
let knownRevision: string | undefined;
const editRevisions = new Map<string, string>();
const pending = new Map<string, { key: string; revision: string }>();
const inFlight = new Map<string, Promise<any>>();
watchSession(() => { knownRevision = undefined; pending.clear(); editRevisions.clear(); inFlight.clear(); });
export function request<T = any>(options: RequestOptions): Promise<T> {
  const identity = `${session()?.user.id || deviceId()}:${options.method || 'GET'}:${options.url}:${JSON.stringify(options.data || {})}`;
  if (inFlight.has(identity)) return inFlight.get(identity)!;
  const work = performRequest<T>(options, identity).finally(() => inFlight.delete(identity));
  inFlight.set(identity, work); return work;
}

async function performRequest<T = any>(options: RequestOptions, identity: string): Promise<T> {
  const { url, method = 'GET', data, header } = options;
  const isRead = method === 'GET';
  const current = session();
  if (!current) throw new Error('正在连接共享仓库，请稍候');
  const cacheKey = `${current?.user.id || deviceId()}:${method}:${url}`;

  try {
    let headers: Record<string,string> = {};
    if (!isRead) {
      if (!pending.has(identity)) {
        const sync = await fetchApi('/api/sync', 'GET', undefined, current?.token ? { Authorization: `Bearer ${current.token}` } : {}, 10000);
        if (sync.statusCode === 401 && current) { setSession(null); throw new Error('登录已过期'); }
        if (sync.statusCode !== 200 || !(sync.data as any)?.success) throw new Error('未提交：无法确认服务器状态');
        const serverRevision = String((sync.data as any).data.revision);
        const expected = editRevisions.get(url) || knownRevision || serverRevision;
        pending.set(identity, { key: `${Date.now()}-${deviceId()}-${Math.random().toString(36).slice(2, 12)}`, revision: expected });
      }
      const attempt = pending.get(identity)!;
      headers = { 'Idempotency-Key': attempt.key, 'If-Match': attempt.revision };
    }
    const requestHeaders: Record<string, string> = { ...header, ...headers };
    if (method !== 'GET') {
      requestHeaders['Content-Type'] = 'application/json';
      requestHeaders['X-Warehouse-Device'] = deviceId();
    }
    if (current?.token) requestHeaders.Authorization = `Bearer ${current.token}`;
    const res = await fetchApi(url, method, data, requestHeaders, 15000);
    if (current && session()?.token !== current.token) throw new Error('账号已切换');
    if (res.statusCode === 401) { setSession(null); knownRevision = undefined; pending.clear(); throw new Error('登录已过期，请重新登录'); }
    if (res.statusCode < 500) pending.delete(identity);
    const revisionHeader = Object.entries(res.header || {}).find(([key]) => key.toLowerCase() === 'x-warehouse-revision')?.[1];
    if (revisionHeader !== undefined && res.statusCode >= 200 && res.statusCode < 300) knownRevision = String(revisionHeader);
    if (isRead && revisionHeader !== undefined && /^\/api\/\w+\/\d+$/.test(url)) editRevisions.set(url, String(revisionHeader));
    if (!isRead && res.statusCode >= 200 && res.statusCode < 300) editRevisions.delete(url);
    if (res.statusCode === 409) { knownRevision = undefined; refreshSharedData(); throw new Error((res.data as any)?.message || '数据已变化，请刷新'); }
    setOffline(false);
    console.log(`[API] ${method} ${url}`, res.statusCode);

    if (res.statusCode >= 200 && res.statusCode < 300) {
      const body = res.data as any;
      if (body && body.success) {
        if (isRead) cacheSet(cacheKey, body.data);
        else { evictRelated(); refreshSharedData(); }
        return body.data as T;
      }
      throw new Error(body?.message || '请求失败');
    }
    throw new Error((res.data as any)?.message || `HTTP ${res.statusCode}`);
  } catch (e: any) {
    const raw = String(e?.message || e?.errMsg || '');

    // 读接口：网络/服务异常时回退到本地缓存，同时进入离线模式
    if (isRead && (isNetworkError(e) || /^HTTP 5\d\d$/.test(raw))) {
      const cached = cacheGet<T>(cacheKey);
      setOffline(true);
      if (cached !== undefined) {
        console.warn(`[API] 离线模式，使用本地缓存: ${url}`);
        return cached;
      }
      const msg = '暂无本地数据，请检查网络后重试';
      toastOnce(msg);
      console.error(`[API] ${method} ${url} 失败(无缓存):`, e?.message || e);
      throw new Error(msg);
    }

    // 写接口或其他错误：正常提示
    const msg = !isRead && isNetworkError(e) ? '上传结果未确认，表单已保留；请勿更改内容，联网后重试' : friendlyError(e);
    console.error(`[API] ${method} ${url} 失败:`, e?.message || e);
    toastOnce(msg);
    throw new Error(msg);
  }
}
