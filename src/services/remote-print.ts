import Taro from '@tarojs/taro';
import { getBaseUrl } from './request';

export type RemoteDevice = { id: string; name: string; printer: string; online: boolean; ready: boolean; last_seen?: number };
export type RemoteJob = { id: string; status: 'waiting' | 'processing' | 'queued' | 'failed' | 'uncertain' | 'expired'; message: string; created_at?: number; updated_at?: number };
const key = 'warehouse_remote_print_pair_v1';
export const readPrintPair = (): string => { try { return Taro.getStorageSync(key) || ''; } catch { return ''; } };
export const savePrintPair = (value: string) => Taro.setStorageSync(key, value);
export const readPrintAttempt = (fingerprint: string): string => { try { return Taro.getStorageSync(key + ':' + fingerprint) || ''; } catch { return ''; } };
export const savePrintAttempt = (fingerprint: string, id: string) => Taro.setStorageSync(key + ':' + fingerprint, id);

export function newRemotePrintId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return 'remote-' + crypto.randomUUID();
  // Older WebViews and HTTP previews may not expose randomUUID.
  return 'remote-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
}

// Pairing is the authorization for this API. A print job has its own durable
// idempotency ID; it must not wait for warehouse sync or clear the warehouse
// session when a printer pairing expires.
async function remoteRequest<T>(path: string, token: string, data?: unknown): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('请先连接打印电脑');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(data === undefined ? '打印状态查询超时，正在自动重试' : '发送结果尚未确认，正在查询原任务，请勿重复发送'));
      controller.abort();
    }, 8000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(getBaseUrl() + '/api/remote-print/' + path, {
        method: data === undefined ? 'GET' : 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'X-Print-Client': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: data === undefined ? undefined : JSON.stringify(data)
      });
      let body: any;
      try { body = await response.json(); } catch { throw new Error('打印服务响应异常，请刷新打印状态'); }
      if (!response.ok || body?.success !== true || body.data == null) {
        throw Object.assign(new Error(body?.message || '打印服务暂时不可用，请刷新打印状态'), { statusCode: response.status });
      }
      return body.data as T;
    })()]);
  } catch (error) {
    if (/fetch|network|load failed|abort/i.test(String(error?.message || ''))) {
      throw new Error(data === undefined ? '暂时无法查询打印状态，网络恢复后自动重试' : '网络中断，发送结果尚未确认，正在查询原任务');
    }
    throw error;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export const getRemoteDevice = (token = readPrintPair()) => remoteRequest<RemoteDevice>('device', token);
export const getRemotePrintHistory = () => remoteRequest<{ note_id: number; printed_at: number }[]>('history', readPrintPair());
export const submitRemotePrint = (data: { id: string; note_id: number; version: number; paper: string }, token = readPrintPair()) => remoteRequest<RemoteJob>('jobs', token, data);
export const getRemotePrintJob = (id: string, token = readPrintPair()) => remoteRequest<RemoteJob>('jobs/' + encodeURIComponent(id), token);
// Only a person at the printer knows whether paper came out, so this is the one
// place the app asks instead of guessing. It clears the device queue block.
export const resolveRemotePrintJob = (id: string, outcome: 'printed' | 'missing', token = readPrintPair()) =>
  remoteRequest<RemoteJob>('jobs/' + encodeURIComponent(id) + '/resolve', token, { outcome });
