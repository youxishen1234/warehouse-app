import Taro from '@tarojs/taro';
import type { LabelKind, LabelSnapshot } from '@/features/label-print';
import type { MediaProfile } from '@/features/label-print/native';
import { getBaseUrl } from './request';
import { readPrintPair } from './remote-print';

export type RemoteLabelKind = LabelKind | 'calibration';
export type RemoteLabelStatus = 'waiting' | 'processing' | 'queued' | 'failed' | 'uncertain' | 'expired';
export type RemoteLabelDevice = {
  id: string;
  name: string;
  printer: string;
  online: boolean;
  ready: boolean;
  profiles: MediaProfile[];
  maxCopies: number;
};
export type RemoteLabelJob = {
  id: string;
  kind: RemoteLabelKind;
  status: RemoteLabelStatus;
  message: string;
  created_at?: string | number;
  updated_at?: string | number;
};
export type RemoteLabelJobInput = {
  id: string;
  kind: RemoteLabelKind;
  profileId: string;
  copies: number;
  data?: LabelSnapshot;
};
export type RemoteLabelAttempt = {
  id: string;
  fingerprint: string;
  deviceId: string;
  printer: string;
  profileId: string;
  kind: RemoteLabelKind;
  copies: number;
  data?: LabelSnapshot;
  startedAt: number;
};

const attemptKey = 'warehouse_remote_label_attempt_v1';

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '标签打印服务暂时不可用，请刷新状态';
}

export function readRemoteLabelAttempt(): RemoteLabelAttempt | null {
  try {
    const value = Taro.getStorageSync(attemptKey);
    if (!value || typeof value !== 'object') return null;
    const attempt = value as RemoteLabelAttempt;
    if (typeof attempt.id !== 'string' || typeof attempt.fingerprint !== 'string' ||
      typeof attempt.deviceId !== 'string' || typeof attempt.profileId !== 'string' ||
      typeof attempt.printer !== 'string' || typeof attempt.kind !== 'string' ||
      !Number.isFinite(attempt.startedAt)) return null;
    return attempt;
  } catch { return null; }
}

export function saveRemoteLabelAttempt(attempt: RemoteLabelAttempt): void {
  Taro.setStorageSync(attemptKey, attempt);
}

export function newRemoteLabelJobId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `label-${crypto.randomUUID()}`;
  return `label-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function remoteLabelRequest<T>(path: string, method: 'GET' | 'POST', data?: unknown, token = readPrintPair()): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('请先连接打印电脑');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(method === 'GET'
        ? '打印状态查询超时，网络恢复后会继续查询'
        : '打印任务回执未确认；正在查询原任务，不会自动重复提交'));
    }, 8000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(`${getBaseUrl()}/api/remote-print/labels/${path}`, {
        method,
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'X-Print-Client': token,
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: data === undefined ? undefined : JSON.stringify(data)
      });
      let body: any;
      try { body = await response.json(); } catch { throw new Error('标签打印服务响应异常，请刷新打印状态'); }
      if (!response.ok || body?.success !== true || body.data == null) {
        const issue = new Error(body?.message || '标签打印服务暂时不可用，请刷新打印状态');
        Object.assign(issue, { statusCode: response.status });
        throw issue;
      }
      return body.data as T;
    })()]);
  } catch (error) {
    const message = messageOf(error);
    if (/fetch|network|load failed|abort/i.test(message)) {
      throw new Error(method === 'GET'
        ? '暂时无法查询标签打印状态，网络恢复后自动重试'
        : '网络中断，标签任务回执未确认；正在查询原任务，不会自动重发');
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const encoded = (value: string) => encodeURIComponent(value);

export const getRemoteLabelDevice = (token = readPrintPair()) =>
  remoteLabelRequest<RemoteLabelDevice>('device', 'GET', undefined, token);

export const saveRemoteLabelProfile = (profile: MediaProfile, token = readPrintPair()) =>
  remoteLabelRequest<MediaProfile>('profiles', 'POST', { profile }, token);

export const submitRemoteLabelJob = (input: RemoteLabelJobInput, token = readPrintPair()) =>
  remoteLabelRequest<RemoteLabelJob>('jobs', 'POST', input, token);

export const getRemoteLabelJob = (id: string, token = readPrintPair()) =>
  remoteLabelRequest<RemoteLabelJob>(`jobs/${encoded(id)}`, 'GET', undefined, token);

export const resolveRemoteLabelJob = (id: string, outcome: 'printed' | 'missing', token = readPrintPair()) =>
  remoteLabelRequest<RemoteLabelJob>(`jobs/${encoded(id)}/resolve`, 'POST', { outcome }, token);

export const confirmRemoteLabelCalibration = (profileId: string, jobId: string, token = readPrintPair()) =>
  remoteLabelRequest<MediaProfile>(`profiles/${encoded(profileId)}/confirm`, 'POST', { jobId }, token);

export const remoteLabelErrorMessage = messageOf;
