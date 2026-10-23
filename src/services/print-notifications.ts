import Taro from '@tarojs/taro';
import { useEffect, useState } from 'react';
import { getRemoteDevice, getRemotePrintJob, getRemotePrintRecovery, readPrintPair, resolveRemotePrintJob } from './remote-print';
import type { RemoteDevice, RemoteJob, RemotePrintRecovery } from './remote-print';

export type PrintNoticeRecord = {
  id: string;
  noteId: number;
  noteNumber: string;
  printer: string;
  deviceId: string;
  createdAt: number;
  job?: RemoteJob;
  error?: string;
  dismissed?: boolean;
};

export type PrintNoticeSnapshot = {
  records: PrintNoticeRecord[];
  device?: RemoteDevice;
  recovery?: RemotePrintRecovery;
  deviceError: string;
  now: number;
  checking: boolean;
};

export type PrintNoticeDescription = {
  title: string;
  message: string;
  tone: 'info' | 'warning' | 'danger' | 'success';
};

const STORAGE_KEY = 'warehouse_print_notices_v1';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 20;
const MAX_POLLED_TASKS = 10;
const POLL_INTERVAL_MS = 5000;

type StoredNotices = {
  version: 1;
  pairFingerprint: string;
  deviceId?: string;
  records: PrintNoticeRecord[];
};

const validStatuses = new Set<RemoteJob['status']>(['waiting', 'processing', 'queued', 'failed', 'uncertain', 'expired']);
const terminalStatuses = new Set<RemoteJob['status']>(['queued', 'failed', 'expired']);

// A non-secret local scope marker. The raw pairing token is never persisted here.
function fingerprintPair(token: string): string {
  if (!token) return '';
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < token.length; index++) {
    const code = token.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
}

function safeReadStored(): StoredNotices | undefined {
  try {
    const value = Taro.getStorageSync(STORAGE_KEY);
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1
      || typeof parsed.pairFingerprint !== 'string' || !Array.isArray(parsed.records)) return undefined;
    return parsed as StoredNotices;
  } catch {
    return undefined;
  }
}

function safeRemoveStored(): void {
  try {
    if (typeof Taro.removeStorageSync === 'function') Taro.removeStorageSync(STORAGE_KEY);
  } catch {
    // Keep the in-memory state authoritative if the storage provider is unavailable.
  }
}

function safeWriteStored(value: StoredNotices): void {
  try {
    Taro.setStorageSync(STORAGE_KEY, value);
  } catch {
    // Storage quota failures must not discard the in-memory notice.
  }
}

function normalizeJob(job: any): RemoteJob | undefined {
  if (!job || typeof job !== 'object' || typeof job.id !== 'string'
    || !validStatuses.has(job.status) || typeof job.message !== 'string') return undefined;
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    ...(Number.isFinite(job.created_at) ? { created_at: job.created_at } : {}),
    ...(Number.isFinite(job.updated_at) ? { updated_at: job.updated_at } : {})
  };
}

function normalizeRecord(value: any): PrintNoticeRecord | undefined {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id
    || !Number.isSafeInteger(value.noteId) || typeof value.noteNumber !== 'string'
    || typeof value.printer !== 'string' || typeof value.deviceId !== 'string'
    || !Number.isFinite(value.createdAt)) return undefined;
  const job = value.job === undefined ? undefined : normalizeJob(value.job);
  if (value.job !== undefined && !job) return undefined;
  return {
    id: value.id,
    noteId: value.noteId,
    noteNumber: value.noteNumber,
    printer: value.printer,
    deviceId: value.deviceId,
    createdAt: value.createdAt,
    ...(job ? { job } : {}),
    ...(typeof value.error === 'string' && value.error ? { error: value.error.slice(0, 500) } : {}),
    ...(value.dismissed === true ? { dismissed: true } : {})
  };
}

function isPending(record: PrintNoticeRecord): boolean {
  // `uncertain` blocks the printer queue until a person checks the paper, so
  // keep observing it and never prune it as an ordinary old terminal.
  return !record.job || !terminalStatuses.has(record.job.status);
}

function terminalAt(record: PrintNoticeRecord): number {
  return record.job?.updated_at ?? record.job?.created_at ?? record.createdAt;
}

function pruneRecords(records: PrintNoticeRecord[], now: number): PrintNoticeRecord[] {
  // An uncertain job keeps blocking the printer until it is reconciled, so
  // it stays visible even when its timestamp is older than the retention.
  const retained = records.filter(record => isPending(record)
    || (record.job?.status !== 'uncertain' && now - terminalAt(record) <= RETENTION_MS));
  const pending = retained.filter(isPending);
  const terminal = retained.filter(record => !isPending(record))
    .sort((left, right) => right.createdAt - left.createdAt);
  const remainingSlots = Math.max(0, MAX_RECORDS - pending.length);
  return [...pending, ...terminal.slice(0, remainingSlots)]
    .sort((left, right) => right.createdAt - left.createdAt);
}

function messageOf(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error
    ? String((error as { message?: unknown }).message || '') : '';
  return (message || '打印状态暂时无法查询').slice(0, 500);
}

let currentToken = readPrintPair();
let pairFingerprint = fingerprintPair(currentToken);
let pairGeneration = 0;
let storedDeviceId = '';
const persisted = safeReadStored();
let records: PrintNoticeRecord[] = [];
if (persisted && currentToken && persisted.pairFingerprint === pairFingerprint) {
  storedDeviceId = typeof persisted.deviceId === 'string' ? persisted.deviceId : '';
  records = pruneRecords(persisted.records.map(normalizeRecord).filter((record): record is PrintNoticeRecord => !!record), Date.now());
} else {
  // A missing/invalid scope is not safe to associate with the current printer.
  safeRemoveStored();
}

let snapshot: PrintNoticeSnapshot = {
  records,
  device: undefined,
  deviceError: '',
  now: Date.now(),
  checking: false
};
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* One subscriber must not block other screens. */ }
  }
}

function persistRecords(nextRecords: PrintNoticeRecord[]): void {
  safeWriteStored({
    version: 1,
    pairFingerprint,
    ...(storedDeviceId ? { deviceId: storedDeviceId } : {}),
    records: nextRecords
  });
}

function commitRecords(nextRecords: PrintNoticeRecord[], now = Date.now()): void {
  records = pruneRecords(nextRecords, now);
  snapshot = { ...snapshot, records, now };
  persistRecords(records);
  notify();
}

function syncPairing(): boolean {
  let token = '';
  try { token = readPrintPair(); } catch { token = ''; }
  const nextFingerprint = fingerprintPair(token);
  if (nextFingerprint === pairFingerprint) return false;
  currentToken = token;
  pairFingerprint = nextFingerprint;
  pairGeneration++;
  storedDeviceId = '';
  records = [];
  safeRemoveStored();
  snapshot = { records, device: undefined, deviceError: '', now: Date.now(), checking: false };
  persistRecords(records);
  notify();
  return true;
}

function isCurrentPair(generation: number, fingerprint: string): boolean {
  syncPairing();
  return generation === pairGeneration && fingerprint === pairFingerprint;
}

export function readPrintNotices(): PrintNoticeSnapshot {
  syncPairing();
  return snapshot;
}

export function watchPrintNotices(listener: () => void): () => void {
  syncPairing();
  listeners.add(listener);
  let watching = true;
  return () => {
    if (!watching) return;
    watching = false;
    listeners.delete(listener);
  };
}

export function trackPrintNotice(record: PrintNoticeRecord): void {
  syncPairing();
  const existing = records.find(item => item.id === record.id);
  if (existing) {
    // Idempotent pre-submit tracking must not erase a previously observed status.
    const merged: PrintNoticeRecord = {
      ...existing,
      noteId: record.noteId,
      noteNumber: record.noteNumber,
      printer: record.printer,
      deviceId: record.deviceId,
      createdAt: existing.createdAt,
      ...(record.job ? { job: record.job } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(existing.dismissed ? { dismissed: true } : {})
    };
    if (record.job || record.error || record.noteNumber !== existing.noteNumber || record.printer !== existing.printer
      || record.deviceId !== existing.deviceId || record.noteId !== existing.noteId) {
      commitRecords(records.map(item => item.id === record.id ? merged : item));
    }
    return;
  }
  commitRecords([{ ...record }, ...records]);
}

export function updatePrintNotice(job: RemoteJob): void {
  syncPairing();
  const current = records.find(record => record.id === job.id);
  if (!current) return;
  const changed = !current.job || current.job.status !== job.status;
  commitRecords(records.map(record => record.id === job.id
    ? {
        ...record,
        job: { ...job },
        error: undefined,
        // A closed banner returns on the next real status change, but a
        // repeated poll of the same state must not make it reappear.
        ...(changed ? { dismissed: false } : {})
      }
    : record));
}

export function reportPrintNoticeError(id: string, message: string): void {
  syncPairing();
  const current = records.find(record => record.id === id);
  if (!current) return;
  const detail = (message || '打印状态暂未确认').slice(0, 500);
  commitRecords(records.map(record => record.id === id
    ? { ...record, error: detail }
    : record));
}

export function dismissPrintNotice(id: string): void {
  syncPairing();
  if (!records.some(record => record.id === id)) return;
  commitRecords(records.map(record => record.id === id ? { ...record, dismissed: true } : record));
}

let refreshInFlight: Promise<void> | undefined;
let refreshFlightGeneration = -1;

async function performRefresh(token: string, generation: number, fingerprint: string): Promise<void> {
  const now = Date.now();
  snapshot = { ...snapshot, now, checking: true };
  notify();

  // Closing a banner only hides it; the original task still needs to be
  // observed so its eventual state can be announced.
  const ids = records.filter(isPending)
    .sort((left, right) => {
      const priority = (record: PrintNoticeRecord) => record.job?.status === 'uncertain' ? 0 : 1;
      return priority(left) - priority(right) || left.createdAt - right.createdAt;
    })
    .slice(0, MAX_POLLED_TASKS);
  // Recovery context is only shown alongside a pending notice. With nothing
  // pending, the background monitor must not keep polling device state.
  if (!ids.length) {
    snapshot = { ...snapshot, checking: false, now: Date.now() };
    notify();
    return;
  }
  const deviceRequest = getRemoteDevice(token).then(
    device => ({ ok: true as const, device }),
    error => ({ ok: false as const, error })
  );
  const recoveryRequest = getRemotePrintRecovery(token).then(
    recovery => ({ ok: true as const, recovery }),
    () => ({ ok: false as const })
  );
  const jobRequests = ids.map(async record => {
    try { return { id: record.id, job: await getRemotePrintJob(record.id, token) }; }
    catch (error) { return { id: record.id, error }; }
  });

  const [deviceResult, recoveryResult, jobResults] = await Promise.all([
    deviceRequest,
    recoveryRequest,
    Promise.all(jobRequests)
  ]);
  if (!isCurrentPair(generation, fingerprint)) return;

  if (deviceResult.ok) {
    const nextDeviceId = deviceResult.device?.id || '';
    const priorDeviceId = storedDeviceId || records[0]?.deviceId || '';
    if (priorDeviceId && nextDeviceId && priorDeviceId !== nextDeviceId) {
      // Same pairing token unexpectedly points at a different device: discard the old scope.
      records = [];
      storedDeviceId = nextDeviceId;
      safeRemoveStored();
      snapshot = { records, device: deviceResult.device, deviceError: '', now: Date.now(), checking: true };
      persistRecords(records);
    } else if (nextDeviceId) {
      storedDeviceId = nextDeviceId;
    }
    snapshot = { ...snapshot, device: deviceResult.device, deviceError: '', now: Date.now() };
  } else {
    snapshot = { ...snapshot, deviceError: messageOf(deviceResult.error), now: Date.now() };
  }
  if (recoveryResult.ok) snapshot = { ...snapshot, recovery: recoveryResult.recovery, now: Date.now() };

  const allowedIds = new Set(records.filter(isPending).map(record => record.id));
  const nextRecords = records.map(record => {
    if (!allowedIds.has(record.id)) return record;
    const result = jobResults.find(item => item.id === record.id);
    if (!result) return record;
    if ('job' in result && result.job) {
      // A newly recovered job is not a status change: it may simply be the
      // first successful poll after the operator dismissed a pending banner.
      const changed = !!record.job && record.job.status !== result.job.status;
      return { ...record, job: { ...result.job }, error: undefined, ...(changed ? { dismissed: false } : {}) };
    }
    if ('error' in result) return { ...record, error: messageOf(result.error) };
    return record;
  });
  records = pruneRecords(nextRecords, Date.now());
  snapshot = { ...snapshot, records, now: Date.now() };
  persistRecords(records);
  notify();
}

export function refreshPrintNotices(): Promise<void> {
  syncPairing();
  const token = currentToken;
  if (refreshInFlight) {
    if (refreshFlightGeneration === pairGeneration) return refreshInFlight;
    return refreshInFlight.then(() => refreshPrintNotices());
  }
  if (!token) {
    snapshot = { ...snapshot, device: undefined, deviceError: '请先连接打印电脑', now: Date.now(), checking: false };
    notify();
    return Promise.resolve();
  }
  const generation = pairGeneration;
  const fingerprint = pairFingerprint;
  refreshFlightGeneration = generation;
  const task = performRefresh(token, generation, fingerprint).catch(error => {
    if (isCurrentPair(generation, fingerprint)) {
      snapshot = { ...snapshot, deviceError: messageOf(error), now: Date.now() };
      notify();
    }
  }).finally(() => {
    if (refreshFlightGeneration === generation) {
      refreshInFlight = undefined;
      refreshFlightGeneration = -1;
    }
    if (generation === pairGeneration) {
      snapshot = { ...snapshot, checking: false, now: Date.now() };
      notify();
    }
  });
  refreshInFlight = task;
  return task;
}

let monitorReferences = 0;
let monitorTimer: ReturnType<typeof setInterval> | undefined;
let monitorVisibilityTarget: Document | undefined;
let monitorWindowTarget: Window | undefined;

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || !document.hidden;
}

function startMonitorTimer(): void {
  if (monitorTimer !== undefined || monitorReferences <= 0 || !isDocumentVisible()) return;
  void refreshPrintNotices();
  monitorTimer = setInterval(() => {
    if (isDocumentVisible()) void refreshPrintNotices();
  }, POLL_INTERVAL_MS);
}

function stopMonitorTimer(): void {
  if (monitorTimer === undefined) return;
  clearInterval(monitorTimer);
  monitorTimer = undefined;
}

function onMonitorVisibilityChange(): void {
  if (!isDocumentVisible()) {
    stopMonitorTimer();
    return;
  }
  startMonitorTimer();
}

function onMonitorWake(): void {
  if (isDocumentVisible()) void refreshPrintNotices();
}

function attachMonitorListeners(): void {
  if (typeof document !== 'undefined') {
    monitorVisibilityTarget = document;
    document.addEventListener('visibilitychange', onMonitorVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    monitorWindowTarget = window;
    window.addEventListener('online', onMonitorWake);
    window.addEventListener('focus', onMonitorWake);
  }
}

function detachMonitorListeners(): void {
  if (monitorVisibilityTarget) monitorVisibilityTarget.removeEventListener('visibilitychange', onMonitorVisibilityChange);
  if (monitorWindowTarget) {
    monitorWindowTarget.removeEventListener('online', onMonitorWake);
    monitorWindowTarget.removeEventListener('focus', onMonitorWake);
  }
  monitorVisibilityTarget = undefined;
  monitorWindowTarget = undefined;
}

export function startPrintNoticeMonitor(): () => void {
  monitorReferences++;
  if (monitorReferences === 1) {
    attachMonitorListeners();
    startMonitorTimer();
  }
  let started = true;
  return () => {
    if (!started) return;
    started = false;
    monitorReferences = Math.max(0, monitorReferences - 1);
    if (monitorReferences === 0) {
      stopMonitorTimer();
      detachMonitorListeners();
    }
  };
}

export function describePrintNotice(record: PrintNoticeRecord, state: PrintNoticeSnapshot): PrintNoticeDescription {
  const job = record.job;
  const recovery = state.recovery;
  const recovered = !!recovery && recovery.count > 0;
  const recoveryAge = recovered && recovery.last_at ? state.now - recovery.last_at : Infinity;
  // Old recovery events stay available as a tail, but only a recent one can
  // explain the current delay, and only when it happened after this notice
  // was created. Never let this text claim paper came out.
  // Server timestamps can run ahead of a device clock; a future start time
  // must not hide a recovery that really happened during this wait.
  const noticeStartedAt = Math.min(job?.created_at ?? record.createdAt, state.now);
  const recentRecovery = recovered && recoveryAge <= 10 * 60 * 1000
    && (recovery.last_at ?? 0) >= noticeStartedAt - 30_000;
  const recoveryMessage = recentRecovery
    ? `打印电脑刚刚${recovery.last_kind === 'spooler' ? '自动恢复了打印服务' : '重新启动了接收程序'}，原任务没有被重复发送。`
    : '';
  if (job?.status === 'uncertain') {
    const extra = state.deviceError ? ` ${state.deviceError}。` : '';
    return {
      title: '打印结果待人工核对',
      message: `打印任务结果尚未确认，需要人工核对打印队列和实际出纸；核对前不要再次发送。${extra}`,
      tone: 'danger'
    };
  }
  if (record.error || (state.deviceError && (!job || job.status === 'waiting' || job.status === 'processing'))) {
    const detail = record.error || state.deviceError;
    return {
      title: '打印状态暂未确认',
      message: `暂时无法确认原任务状态：${detail}。请在打印端核对原任务；系统不会自动重复发送。`,
      tone: 'warning'
    };
  }
  if (!job) {
    return {
      title: '打印状态暂未确认',
      message: `正在等待原任务的状态信息，请勿重复发送。${recoveryMessage}`,
      tone: 'warning'
    };
  }
  if (job.status === 'waiting') {
    if (state.device && !state.device.online) {
      return {
        title: '等待打印电脑上线',
        message: `打印电脑当前离线，任务仍在等待接收；电脑上线后将由原任务继续处理。${recoveryMessage}`,
        tone: 'warning'
      };
    }
    if (state.device?.online && !state.device.ready) {
      return {
        title: '打印机暂不可用',
        message: `打印电脑在线，但打印机暂不可用；任务仍在等待原打印机处理。${recoveryMessage}`,
        tone: 'warning'
      };
    }
    return {
      title: '等待打印电脑接收',
      message: job.message || '打印任务正在等待打印电脑接收。',
      tone: 'info'
    };
  }
  if (job.status === 'processing') {
    const since = job.updated_at ?? job.created_at ?? record.createdAt;
    if (state.now - since > 60_000) {
      return {
        title: '打印处理时间较长',
        message: `打印电脑处理原任务已超过 1 分钟，请查看打印电脑状态；不要重复发送。${recoveryMessage}`,
        tone: 'warning'
      };
    }
    return {
      title: '打印处理中',
      message: `${job.message || '打印电脑正在处理原任务。'}${recoveryMessage}`,
      tone: 'info'
    };
  }
  if (job.status === 'queued') {
    if (/人工核对|人工确认/.test(job.message)) {
      return { title: '经人工确认实际出纸', message: job.message, tone: 'success' };
    }
    return {
      title: '已送入打印队列',
      message: `${job.message || '原任务已进入打印队列'}。进入队列不代表纸张已实际打印出来，请以实际出纸为准。`,
      tone: 'info'
    };
  }
  if (job.status === 'failed') {
    return {
      title: '打印任务失败',
      message: `${job.message || '打印机未能完成原任务'}。请检查打印电脑和打印机状态，并核对原任务后再决定是否重试。`,
      tone: 'danger'
    };
  }
  return {
    title: '打印任务已过期',
    message: job.message || '原任务已过期且不会自动重发，请核对任务状态后再操作。',
    tone: 'warning'
  };
}

export function usePrintNotices(): PrintNoticeSnapshot {
  const [state, setState] = useState(readPrintNotices);
  useEffect(() => {
    setState(readPrintNotices());
    return watchPrintNotices(() => setState(readPrintNotices()));
  }, []);
  return state;
}

export async function resolvePrintNotice(id: string, outcome: 'printed' | 'missing') {
  if (!records.some(row => row.id === id)) throw new Error('找不到待确认的打印任务');
  if (!currentToken) throw new Error('请先连接打印电脑');
  const generation = pairGeneration, fingerprint = pairFingerprint;
  const job = await resolveRemotePrintJob(id, outcome, currentToken);
  if (generation === pairGeneration && fingerprint === pairFingerprint) updatePrintNotice(job);
  return job;
}
