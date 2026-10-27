import Taro from '@tarojs/taro';
import { getBaseUrl } from './request';
import { readBluetooth630KPending, readRemotePrintPending, REMOTE_PRINT_PENDING_KEY } from './print-transport-pending';
export { readRemotePrintPending } from './print-transport-pending';

export type RemoteDevice = { id: string; name: string; printer: string; online: boolean; ready: boolean; last_seen?: number };
export type RemotePrintRecovery = {
  count: number;
  last_at?: number;
  last_kind: 'receiver' | 'spooler';
  repaired: boolean;
};
export type RemoteJob = { id: string; status: 'waiting' | 'processing' | 'queued' | 'failed' | 'uncertain' | 'expired'; message: string; created_at?: number; updated_at?: number; confirmed_printed_at?: number };
const key = 'warehouse_remote_print_pair_v1';
const autoPrintKey = 'warehouse_print_after_outbound_v1';
const submitCallsInFlight = new Map<string, { active: number; started: number }>();
// POST /remote-print/jobs emits 400/401 for pre-enqueue auth, note lookup, or
// validation failures; 404/409 and transport/server ambiguity stay gated.
const isDefinitiveFirstSubmitRejection = (error: any): boolean => error?.statusCode === 400 || error?.statusCode === 401;
function clearRejectedFirstPending(id: string): void {
  try { if (readRemotePrintPending(true)?.id === id) Taro.removeStorageSync(REMOTE_PRINT_PENDING_KEY); }
  catch { /* Preserve the gate if local storage cannot safely clear it. */ }
}
function rememberRemotePrintResult(job: RemoteJob): RemoteJob {
  if (['queued', 'failed', 'expired'].includes(job.status) && readRemotePrintPending()?.id === job.id) {
    try { Taro.removeStorageSync(REMOTE_PRINT_PENDING_KEY); }
    catch { /* Keep a conservative pending gate until storage recovers. */ }
  }
  return job;
}
export const readPrintPair = (): string => { try { return Taro.getStorageSync(key) || ''; } catch { return ''; } };
export const savePrintPair = (value: string) => {
  if (readPrintPair() !== value && readRemotePrintPending(true)) throw new Error('网络原任务尚未确认，请先查询原任务，再更换打印电脑');
  if (readPrintPair() !== value) Taro.setStorageSync(autoPrintKey, false);
  Taro.setStorageSync(key, value);
};

const printPairToken = /^[a-f0-9]{64}$/;

/** Accept the receiver's raw token or a link carrying it in print_pair. */
export function parsePrintPairToken(value: string): string {
  const input = String(value || '').trim();
  if (printPairToken.test(input)) return input;
  const sources = [input];
  try {
    const url = new URL(input, 'https://warehouse.invalid');
    sources.push(url.search, url.hash);
  } catch { /* The raw text may still contain a route query. */ }
  for (const source of sources) {
    const marker = source.indexOf('?');
    if (marker < 0) continue;
    const query = source.slice(marker + 1).split('#', 1)[0];
    const candidate = new URLSearchParams(query).get('print_pair')?.trim() || '';
    if (printPairToken.test(candidate)) return candidate;
  }
  return '';
}

/** Remove pairing credentials from both ordinary and hash-router query strings. */
export function cleanPrintPairUrl(value: string): string {
  try {
    const url = new URL(value);
    url.searchParams.delete('print_pair');
    const marker = url.hash.indexOf('?');
    if (marker >= 0) {
      const route = url.hash.slice(0, marker);
      const query = new URLSearchParams(url.hash.slice(marker + 1));
      query.delete('print_pair');
      const remainingQuery = query.toString();
      url.hash = route + (remainingQuery ? `?${remainingQuery}` : '');
    }
    return url.toString();
  } catch { return value; }
}

export function cleanPrintPairFromAddress(): void {
  if (typeof window === 'undefined' || !window.location.href.includes('print_pair=')) return;
  const cleaned = cleanPrintPairUrl(window.location.href);
  if (cleaned !== window.location.href) window.history.replaceState(window.history.state, '', cleaned);
}

export function readPrintPairFromAddress(): string {
  return typeof window === 'undefined' ? '' : parsePrintPairToken(window.location.href);
}

export const readPrintAfterOutbound = (): boolean => { try { return Taro.getStorageSync(autoPrintKey) === true; } catch { return false; } };
export const savePrintAfterOutbound = (value: boolean) => Taro.setStorageSync(autoPrintKey, value);
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
export const submitRemotePrint = async (data: { id: string; note_id: number; version: number; paper: string }, token = readPrintPair()) => {
  if (readBluetooth630KPending(true)) throw new Error('蓝牙原任务尚未确认，请先通过蓝牙查询原任务');
  const pending = readRemotePrintPending(true);
  if (pending && pending.id !== data.id) throw new Error('网络原任务尚未确认，请先查询原任务');
  const isFirstAttempt = !pending;
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('请先连接打印电脑');
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(data.id) || !Number.isSafeInteger(data.note_id) || data.note_id <= 0) throw new Error('打印任务资料无效');
  Taro.setStorageSync(REMOTE_PRINT_PENDING_KEY, { id: data.id, noteId: data.note_id });
  if (readRemotePrintPending(true)?.id !== data.id) throw new Error('原打印任务编号未保存，请重试');
  const submitState = submitCallsInFlight.get(data.id) || { active: 0, started: 0 };
  submitState.active++; submitState.started++; submitCallsInFlight.set(data.id, submitState);
  try {
    return rememberRemotePrintResult(await remoteRequest<RemoteJob>('jobs', token, data));
  } catch (error) {
    // A concurrent same-ID retry makes this result ambiguous, even if this
    // request happened to be the first one attempted.
    if (isFirstAttempt && submitCallsInFlight.get(data.id)?.started === 1 && isDefinitiveFirstSubmitRejection(error)) {
      clearRejectedFirstPending(data.id);
    }
    throw error;
  } finally {
    const state = submitCallsInFlight.get(data.id);
    if (state) { state.active--; if (state.active <= 0) submitCallsInFlight.delete(data.id); }
  }
};
export const getRemotePrintJob = async (id: string, token = readPrintPair()) => rememberRemotePrintResult(await remoteRequest<RemoteJob>('jobs/' + encodeURIComponent(id), token));
// A paper confirmation never submits another task. Only uncertain jobs accept
// "missing"; a queued job may still be physically printing.
export const resolveRemotePrintJob = (id: string, outcome: 'printed' | 'missing', token = readPrintPair()) =>
  remoteRequest<RemoteJob>('jobs/' + encodeURIComponent(id) + '/resolve', token, { outcome }).then(rememberRemotePrintResult);
export const getRemotePrintRecovery = (token = readPrintPair()) => remoteRequest<RemotePrintRecovery>('recovery', token);
