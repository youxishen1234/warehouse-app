import Taro from '@tarojs/taro';
export const TEAM_ORIGIN = 'http://152.136.100.200';
export const PUBLIC_ORIGIN = 'https://youxishen.online';
export function sessionOrigin(): string {
  try {
    const cap = (globalThis as any).Capacitor;
    if (cap?.isNativePlatform?.()) return TEAM_ORIGIN;
  } catch (e) { /* browser runtime */ }
  return typeof location !== 'undefined' && location.protocol === 'https:' ? PUBLIC_ORIGIN : TEAM_ORIGIN;
}
export type Member = { id: string; username: string; role: 'admin' | 'operator' | 'viewer'; disabled?: boolean };
type Session = { token: string; user: Member };
const key = 'warehouse_session_v1';
const subscribers = new Set<() => void>();
const deviceKey = 'warehouse_device_id_v1';
export function deviceId(): string { let value = Taro.getStorageSync(deviceKey); if (!value) { value = `device-${Date.now()}-${Math.random().toString(36).slice(2)}`; Taro.setStorageSync(deviceKey, value); } return String(value); }
export function session(): Session | null { return Taro.getStorageSync(key) || null; }
export function setSession(value: Session | null) {
  if (value) Taro.setStorageSync(key, value); else Taro.removeStorageSync(key);
  for (const name of Taro.getStorageInfoSync().keys) if (name.startsWith('sg_api_') || name.startsWith('team_cache_') || name === 'sg_transit') Taro.removeStorageSync(name);
  subscribers.forEach(fn => fn());
}
export function watchSession(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; }
export async function accountApi<T = any>(url: string, method: 'GET'|'POST'|'PUT' = 'GET', data?: any): Promise<T> {
  let lastError: unknown;
  try {
    for (const origin of [...new Set([sessionOrigin(), TEAM_ORIGIN, PUBLIC_ORIGIN])]) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const result = await fetch(origin + '/api' + url, { method, signal: controller.signal, cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session()?.token || ''}` }, body: data === undefined ? undefined : JSON.stringify(data) });
        if (result.status === 401 && url !== '/auth/login') setSession(null);
        const body = await result.json();
        if (!result.ok || !body?.success) throw new Error(body?.message || '连接失败，请重试');
        return body.data;
      } catch (error) {
        lastError = error;
        if (/HTTP|账号|密码|访问密码|权限|登录/.test(String(error?.message || ''))) throw error;
      } finally { clearTimeout(timeout); }
    }
    throw lastError || new Error('连接失败，请重试');
  } catch (error) { throw error; }
}
