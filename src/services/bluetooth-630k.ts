import Taro from '@tarojs/taro';
import { Capacitor } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import {
  BLUETOOTH_630K_PENDING_KEY, readBluetooth630KPending, readRemotePrintPending,
  type PendingBluetooth630KPrint
} from './print-transport-pending';
import {
  BLE_630K_CONTROL_UUID, BLE_630K_DATA_UUID, BLE_630K_INFO_UUID, BLE_630K_MAX_CHUNK,
  BLE_630K_SERVICE_UUID, BLE_630K_STATUS_UUID, Ble630KNotFoundError, createBle630KBegin,
  createBle630KCommand, encodeBle630KEnvelope, frameBle630KControl, frameBle630KData, isBle630KNotFound,
  mayTransferBle630KJob, sha256Hex, validateBle630KJob, validateBle630KRelayInfo,
  type Ble630KJob, type Ble630KJobInput, type Ble630KPrinter
} from './bluetooth-630k-protocol';

const PRINTER_KEY = 'warehouse_bluetooth_630k_printer_v1';
const ATTEMPT_PREFIX = 'warehouse_bluetooth_630k_attempt_v1:';
const STATUS_ATTEMPTS = 8;
const STATUS_INTERVAL_MS = 250;
const DEFAULT_MTU = 23;

export type Bluetooth630KState = { connected: boolean; printer?: Ble630KPrinter; error: string; job?: Ble630KJob };
export type Bluetooth630KAttempt = {
  id: string; status: Ble630KJob['status']; updatedAt: number;
  deviceId?: string; relayId?: string; documentKey?: string; documentNumber?: string;
  paper?: string; sha256?: string; commitStarted?: boolean;
};
type Listener = (state: Bluetooth630KState) => void;
let printer: Ble630KPrinter | undefined;
let connected = false;
let currentError = '';
let currentJob: Ble630KJob | undefined;
let connecting: Promise<Ble630KPrinter> | undefined;
let initialized: Promise<void> | undefined;
let notificationStarted = false;
let commitInFlight = false;
let activeDeviceId = '';
let relayMaxPayload = 512 * 1024;
let relayChunkSize = BLE_630K_MAX_CHUNK;
let controlCommandId = 0;
let controlQueue: Promise<void> = Promise.resolve();
let submission: Promise<Ble630KJob> | undefined;
let submissionId = '';
const listeners = new Set<Listener>();

function storageWrite(key: string, value: unknown): void {
  try {
    Taro.setStorageSync(key, value);
    const saved = Taro.getStorageSync(key);
    if (JSON.stringify(saved) !== JSON.stringify(value)) throw new Error();
  } catch { throw new Error('打印任务本机记录保存失败，请检查设备存储空间后重试'); }
}
function storageRemove(key: string): void {
  try {
    Taro.removeStorageSync(key);
    const saved = Taro.getStorageSync(key);
    if (saved !== undefined && saved !== null && saved !== '') throw new Error();
  } catch { throw new Error('打印任务本机记录更新失败，请勿重复提交'); }
}
function savedPrinter(): Ble630KPrinter | undefined {
  try {
    const value = Taro.getStorageSync(PRINTER_KEY);
    return value && typeof value.deviceId === 'string' && typeof value.relayId === 'string' && typeof value.name === 'string'
      ? value as Ble630KPrinter : undefined;
  } catch { return undefined; }
}
printer = savedPrinter();
const activeJob = (strict = false): PendingBluetooth630KPrint | undefined => readBluetooth630KPending(strict);
function attemptKey(id: string): string { return ATTEMPT_PREFIX + id; }
export function readBluetooth630KJobAttempt(id: string): Bluetooth630KAttempt | undefined {
  try {
    const value = Taro.getStorageSync(attemptKey(id));
    if (!value || typeof value !== 'object' || value.id !== id || typeof value.status !== 'string' ||
      !Number.isSafeInteger(value.updatedAt)) return undefined;
    return { ...value } as Bluetooth630KAttempt;
  } catch { return undefined; }
}
function saveAttempt(value: Bluetooth630KAttempt): void { storageWrite(attemptKey(value.id), value); }
function saveActive(id: string, target: Ble630KPrinter): void {
  const value = { id, deviceId: target.deviceId, relayId: target.relayId };
  storageWrite(BLUETOOTH_630K_PENDING_KEY, value);
  const saved = activeJob(true);
  if (!saved || saved.id !== id || saved.deviceId !== target.deviceId || saved.relayId !== target.relayId) {
    throw new Error('原打印任务未能安全保存，打印提交已停止');
  }
}
function clearActive(id: string): void {
  const active = activeJob(true);
  if (active?.id === id) storageRemove(BLUETOOTH_630K_PENDING_KEY);
}
function assertActiveTarget(active: PendingBluetooth630KPrint, target?: Ble630KPrinter): void {
  const saved = target || printer || savedPrinter();
  if (active.deviceId && saved?.deviceId && active.deviceId !== saved.deviceId) {
    throw new Error('原蓝牙打印电脑尚未核对，不能切换设备');
  }
  if (active.relayId && saved?.relayId && active.relayId !== saved.relayId) {
    throw new Error('原蓝牙打印电脑身份不匹配，请连接原设备核对任务');
  }
}
function publish(): void {
  const state = getBluetooth630KState();
  listeners.forEach(listener => { try { listener(state); } catch { /* Isolate UI listeners. */ } });
}
const messageOf = (error: unknown): string => error instanceof Error && error.message ? error.message : '蓝牙打印连接失败，请重试';
function dataView(value: string | Uint8Array): DataView {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function readText(value: DataView): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

export function isBluetooth630KSupported(): boolean {
  try {
    const capacitor = Capacitor as typeof Capacitor & { isPluginAvailable?: (name: string) => boolean };
    return Capacitor.isNativePlatform() &&
      (typeof capacitor.isPluginAvailable !== 'function' || capacitor.isPluginAvailable('BluetoothLe')) &&
      typeof BleClient.initialize === 'function' && typeof BleClient.requestDevice === 'function';
  } catch { return false; }
}
export function readBluetooth630KPrinter(): Ble630KPrinter | undefined {
  printer ||= savedPrinter();
  return printer ? { ...printer } : undefined;
}

async function ensureInitialized(): Promise<void> {
  if (!initialized) initialized = BleClient.initialize({ androidNeverForLocation: true }).catch(error => { initialized = undefined; throw error; });
  await initialized;
}
async function refreshMtu(deviceId: string): Promise<number> {
  let mtu = await BleClient.getMtu(deviceId).catch(() => DEFAULT_MTU);
  if (!Number.isSafeInteger(mtu) || mtu < DEFAULT_MTU) mtu = DEFAULT_MTU;
  return mtu;
}
function writeControl(command: string): Promise<void> {
  const target = printer;
  if (!connected || !target) return Promise.reject(new Error('请先连接打印电脑'));
  const operation = controlQueue.catch(() => undefined).then(async () => {
    const mtu = await refreshMtu(target.deviceId);
    controlCommandId = (controlCommandId + 1) & 0xffff;
    const frames = frameBle630KControl(command, controlCommandId, mtu);
    for (const frame of frames) {
      await BleClient.write(target.deviceId, BLE_630K_SERVICE_UUID, BLE_630K_CONTROL_UUID, dataView(frame), { timeout: 15000 });
    }
  });
  controlQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function attemptFromJob(job: Ble630KJob, target: Ble630KPrinter, previous?: Bluetooth630KAttempt): Bluetooth630KAttempt {
  return {
    ...previous, id: job.id, status: job.status, updatedAt: job.updatedAt,
    deviceId: target.deviceId, relayId: target.relayId
  };
}
function rememberJob(job: Ble630KJob, target: Ble630KPrinter): Ble630KJob {
  const previous = readBluetooth630KJobAttempt(job.id);
  saveAttempt({ ...attemptFromJob(job, target, previous), commitStarted: true });
  if (job.status === 'received' || job.status === 'processing' || job.status === 'uncertain') saveActive(job.id, target);
  else clearActive(job.id);
  currentJob = { ...job };
  currentError = '';
  publish();
  return job;
}
function uncertainJob(id: string, message: string, target: Ble630KPrinter): Ble630KJob {
  const job: Ble630KJob = { v: 1, id, status: 'uncertain', message, updatedAt: Date.now() };
  const previous = readBluetooth630KJobAttempt(id);
  saveAttempt(attemptFromJob(job, target, previous));
  // Active was durably set before commit; repeat after any disconnect.
  saveActive(id, target);
  currentJob = job; currentError = message; publish();
  return job;
}
function markNotFound(id: string): Ble630KJob | undefined {
  const active = activeJob(true);
  const attempt = readBluetooth630KJobAttempt(id);
  if (active?.id !== id || attempt?.commitStarted !== false || !printer) return undefined;
  assertActiveTarget(active, printer);
  // Only an explicit pre-commit record proves that no print request was sent.
  // Old records and interrupted commits remain gated even after a host 404.
  return rememberJob({
    v: 1, id, status: 'failed', message: '打印资料尚未提交，可以重新发送', updatedAt: Date.now()
  }, printer);
}
function onDisconnect(deviceId: string): void {
  if (activeDeviceId !== deviceId) return;
  connected = false; notificationStarted = false;
  const active = activeJob();
  if (active) {
    const target = printer || (active.deviceId && active.relayId
      ? { deviceId: active.deviceId, relayId: active.relayId, name: '630K 打印电脑' }
      : undefined);
    const attempt = readBluetooth630KJobAttempt(active.id);
    if (attempt?.status === 'queued' || attempt?.status === 'failed') { currentError = '蓝牙打印电脑已断开'; publish(); return; }
    if (target) {
      try { uncertainJob(active.id, '蓝牙连接中断，请查询原任务状态；不会自动重发', target); }
      catch { currentError = '蓝牙已断开，且本机打印状态暂未保存；请恢复原设备连接后核对原任务'; publish(); }
    } else { currentError = '蓝牙已断开；请连接原打印电脑后核对原任务'; publish(); }
  } else { currentError = '蓝牙打印电脑已断开'; publish(); }
}

async function readStatus(id: string): Promise<Ble630KJob> {
  if (!connected || !printer) throw new Error('请先连接打印电脑');
  const target = { ...printer };
  // Windows refreshes the durable job over its local HTTP relay before the
  // status control write is acknowledged. Only accept the subsequent BLE read;
  // never use a locally cached `received` state as a successful query result.
  await writeControl(createBle630KCommand('status', id));
  let lastError: unknown;
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    if (attempt) await delay(STATUS_INTERVAL_MS);
    try {
      const rawText = readText(await BleClient.read(target.deviceId, BLE_630K_SERVICE_UUID, BLE_630K_STATUS_UUID, { timeout: 15000 }));
      const raw = JSON.parse(rawText);
      try { return rememberJob(validateBle630KJob(raw, id), target); }
      catch (error) {
        if (isBle630KNotFound(error)) throw error;
        lastError = error;
        if (raw && typeof raw === 'object' && raw.id !== id) continue;
        throw error;
      }
    } catch (error) {
      if (isBle630KNotFound(error)) throw error;
      lastError = error;
      if (attempt === STATUS_ATTEMPTS - 1) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('打印电脑尚未返回该任务状态，请稍后查询');
}

function setPrinter(value?: Ble630KPrinter): void {
  if (value) storageWrite(PRINTER_KEY, value);
  else storageRemove(PRINTER_KEY);
  printer = value;
}
async function reconcile(id: string): Promise<Ble630KJob> {
  try { return await readStatus(id); }
  catch (error) {
    if (isBle630KNotFound(error)) {
      const notSubmitted = markNotFound(id);
      if (notSubmitted) return notSubmitted;
    }
    throw error;
  }
}

async function connectDevice(deviceId: string, name: string, expectedRelayId?: string): Promise<Ble630KPrinter> {
  const pending = activeJob(true);
  if (pending) {
    if (pending.deviceId && pending.deviceId !== deviceId) throw new Error('存在未确认打印任务，只能连接原打印电脑');
    if (pending.relayId && expectedRelayId && pending.relayId !== expectedRelayId) throw new Error('原打印任务必须连接已配对的打印电脑');
  }
  await ensureInitialized();
  activeDeviceId = deviceId; connected = false; currentError = ''; controlCommandId = 0; publish();
  await BleClient.connect(deviceId, onDisconnect, { timeout: 15000 });
  try {
    // Android requests OS-managed bonding; iOS pairing is managed by CoreBluetooth.
    if (Capacitor.getPlatform() === 'android') {
      const bonded = await BleClient.isBonded(deviceId).catch(() => false);
      if (!bonded) await BleClient.createBond(deviceId, { timeout: 30000 });
    }
    const info = validateBle630KRelayInfo(readText(await BleClient.read(deviceId, BLE_630K_SERVICE_UUID, BLE_630K_INFO_UUID, { timeout: 15000 })));
    if (expectedRelayId && info.relayId !== expectedRelayId) throw new Error('已保存的蓝牙设备身份已变化，请连接原打印电脑');
    relayMaxPayload = info.maxPayload; relayChunkSize = info.chunkSize;
    const nextPrinter = { deviceId, relayId: info.relayId, name: info.name || name || '630K 打印电脑' };
    if (pending?.relayId && pending.relayId !== nextPrinter.relayId) throw new Error('原打印任务的打印电脑身份不匹配');
    setPrinter(nextPrinter);
    await BleClient.startNotifications(deviceId, BLE_630K_SERVICE_UUID, BLE_630K_STATUS_UUID, () => undefined);
    notificationStarted = true;
    connected = true;
    currentError = '';
    await writeControl(createBle630KCommand('hello'));
    const active = activeJob(true);
    if (active) {
      assertActiveTarget(active, nextPrinter);
      try { await reconcile(active.id); }
      catch (error) { currentError = isBle630KNotFound(error) ? '打印电脑尚无此任务，请确认原任务后再继续' : messageOf(error); }
    }
    publish();
    return { ...nextPrinter };
  } catch (error) {
    connected = false; notificationStarted = false;
    try { await BleClient.disconnect(deviceId); } catch { /* Already disconnected. */ }
    if (activeDeviceId === deviceId) activeDeviceId = '';
    throw error;
  }
}

export async function connectBluetooth630K(selectNew = false): Promise<Ble630KPrinter> {
  if (!isBluetooth630KSupported()) throw new Error('当前设备未安装蓝牙打印组件');
  if (submission) throw new Error('蓝牙打印任务正在发送，完成或核对前不能切换连接');
  if (connecting) return connecting;
  const active = activeJob(true);
  if (selectNew && active) throw new Error('存在未确认的原蓝牙打印任务，请连接原打印电脑查询，不能切换设备');
  connecting = (async () => {
    try {
      await ensureInitialized();
      if (selectNew) {
        const selected = await BleClient.requestDevice({ services: [BLE_630K_SERVICE_UUID] });
        if (!selected?.deviceId) throw new Error('没有选择蓝牙打印电脑');
        return await connectDevice(selected.deviceId, selected.name || '630K 打印电脑');
      }
      const pending = activeJob(true);
      const saved = printer || savedPrinter();
      const deviceId = pending?.deviceId || saved?.deviceId;
      const expectedRelayId = pending?.relayId || saved?.relayId;
      if (!deviceId || !expectedRelayId) throw new Error('尚未选择蓝牙打印电脑，请选择设备');
      const device = (await BleClient.getDevices([deviceId])).find(item => item.deviceId === deviceId);
      if (!device) throw new Error('系统未保存原蓝牙打印电脑，请恢复该设备配对后查询原任务');
      return await connectDevice(device.deviceId, device.name || saved?.name || '630K 打印电脑', expectedRelayId);
    } catch (error) { currentError = messageOf(error); publish(); throw error; }
    finally { connecting = undefined; }
  })();
  return connecting;
}

export async function disconnectBluetooth630K(forget = false): Promise<void> {
  if (submission) throw new Error('打印任务正在发送，完成或核对前不能断开设备');
  if (forget && activeJob(true)) throw new Error('存在未确认的原打印任务，核对完成前不能忘记设备');
  const deviceId = printer?.deviceId; const stopNotifications = notificationStarted;
  connected = false; notificationStarted = false;
  if (activeDeviceId === deviceId) activeDeviceId = '';
  if (deviceId) {
    try { if (stopNotifications) await BleClient.stopNotifications(deviceId, BLE_630K_SERVICE_UUID, BLE_630K_STATUS_UUID); } catch { /* Ignore stale registration. */ }
    try { await BleClient.disconnect(deviceId); } catch { /* Already disconnected. */ }
  }
  if (forget) setPrinter(undefined);
  currentError = ''; publish();
}

async function queryOriginalBeforeNewJob(id: string): Promise<void> {
  const pending = activeJob(true);
  if (!pending || pending.id === id) return;
  assertActiveTarget(pending);
  try { await reconcile(pending.id); }
  catch (error) { if (!isBle630KNotFound(error)) throw error; }
  const stillActive = activeJob(true);
  if (stillActive) throw new Error('原蓝牙打印任务仍未终结，请先核对原任务状态');
}

export async function queryBluetooth630KJob(id: string): Promise<Ble630KJob> {
  await queryOriginalBeforeNewJob(id);
  return reconcile(id);
}

async function performSend(input: Ble630KJobInput, onProgress?: (sent: number, total: number) => void): Promise<Ble630KJob> {
  if (!connected || !printer) throw new Error('请先连接打印电脑');
  const bytes = encodeBle630KEnvelope(input);
  const { id } = input;
  await queryOriginalBeforeNewJob(id);
  let existing: Ble630KJob | undefined;
  try {
    existing = await reconcile(id);
    if (!mayTransferBle630KJob(existing)) return existing;
  } catch (error) {
    if (!isBle630KNotFound(error)) throw error;
    // A local active ID means this task may have crossed the commit boundary;
    // a stale host 404 must not turn a reconciliation into an automatic resend.
    if (activeJob(true)?.id === id) throw new Error('原蓝牙打印任务状态尚未确认，请查询原任务；不会自动重发');
  }
  const networkPending = readRemotePrintPending(true);
  if (networkPending) throw new Error('网络打印原任务尚未确认，请先查询网络打印原任务');
  if (!connected || !printer) throw new Error('查询原任务后蓝牙连接已断开，请重新连接并查询原任务');
  const target = { ...printer };
  const pending = activeJob(true);
  if (pending && pending.id !== id) throw new Error('存在其他未确认的蓝牙打印任务，请先查询原任务');
  if (pending) assertActiveTarget(pending, target);
  const mtu = await BleClient.getMtu(target.deviceId).catch(() => DEFAULT_MTU);
  if (bytes.length > relayMaxPayload) throw new Error('打印任务超过打印电脑允许的大小');
  const chunkSize = Math.max(1, Math.min(BLE_630K_MAX_CHUNK, relayChunkSize, mtu - 7));
  const chunks = frameBle630KData(bytes, chunkSize);
  const digest = await sha256Hex(bytes);
  const prior = readBluetooth630KJobAttempt(id);
  if (prior?.sha256 && prior.sha256 !== digest) throw new Error('原任务编号已用于不同打印内容，不能复用');
  const startingAttempt: Bluetooth630KAttempt = {
    ...prior, id, status: 'uncertain', updatedAt: Date.now(), deviceId: target.deviceId,
    relayId: target.relayId, documentKey: input.document.key, documentNumber: input.document.number,
    paper: input.settings.paper, sha256: digest, commitStarted: false
  };
  // Persist a per-job attempt and global ID before any bytes can be committed.
  saveAttempt(startingAttempt);
  saveActive(id, target);
  currentJob = undefined; commitInFlight = false;
  try {
    await writeControl(createBle630KCommand('hello'));
    await writeControl(createBle630KBegin(id, bytes.length, digest, input.settings.paper));
    let sent = 0;
    for (const frame of chunks) {
      await BleClient.write(target.deviceId, BLE_630K_SERVICE_UUID, BLE_630K_DATA_UUID, dataView(frame), { timeout: 15000 });
      sent += frame.length - 4; onProgress?.(sent, bytes.length);
    }
    // A network job could have been created by another view while data was uploading.
    if (readRemotePrintPending(true)) throw new Error('网络打印原任务尚未确认，蓝牙任务未提交；请先核对原打印任务');
    saveActive(id, target);
    saveAttempt({ ...startingAttempt, status: 'uncertain', updatedAt: Date.now(), commitStarted: true });
    commitInFlight = true;
    await writeControl(createBle630KCommand('commit', id));
  } catch (error) {
    if (commitInFlight || !connected) {
      return uncertainJob(id, '提交结果未确认，请查询原任务；不会自动重发', target);
    }
    // Begin/data may have reached the relay; only reconciliation can release the active ID.
    return uncertainJob(id, '打印资料发送中断，请查询原任务；不会自动重发', target);
  }
  try { return await reconcile(id); }
  catch (error) {
    const message = isBle630KNotFound(error)
      ? '已提交但打印电脑暂未确认，请查询原任务；不会自动重发'
      : '已提交但打印状态尚未确认，请查询原任务；不会自动重发';
    return uncertainJob(id, message, target);
  } finally { commitInFlight = false; }
}

export function sendBluetooth630KJob(input: Ble630KJobInput, onProgress?: (sent: number, total: number) => void): Promise<Ble630KJob> {
  if (submission) {
    if (submissionId === input.id) return submission;
    return Promise.reject(new Error('已有蓝牙打印任务正在发送，请等待同一任务完成'));
  }
  submissionId = input.id;
  let tracked: Promise<Ble630KJob>;
  tracked = performSend(input, onProgress).finally(() => {
    if (submission === tracked) { submission = undefined; submissionId = ''; commitInFlight = false; }
  });
  submission = tracked;
  return tracked;
}

export async function resolveBluetooth630KJob(id: string, outcome: 'printed' | 'missing'): Promise<Ble630KJob> {
  const active = activeJob(true);
  if (active && active.id !== id) throw new Error('存在其他未确认的蓝牙打印任务');
  const attempt = readBluetooth630KJobAttempt(id);
  const identity = active || (attempt?.deviceId && attempt.relayId
    ? { id, deviceId: attempt.deviceId, relayId: attempt.relayId }
    : undefined);
  if (!identity) throw new Error('没有可核对的蓝牙打印任务');
  assertActiveTarget(identity);
  if (!connected || !printer) throw new Error('请先连接打印电脑查询原任务');
  const previous = await reconcile(id);
  const canConfirmPrinted = previous.status === 'queued' && outcome === 'printed';
  const canResolveUncertain = previous.status === 'uncertain';
  if (previous.status === 'queued' && outcome === 'missing') throw new Error('打印电脑已接受任务，不能按未打印重新发送');
  if (!canConfirmPrinted && !canResolveUncertain) throw new Error('只有结果不确定的任务可以核对，或确认已进入队列的任务实际出纸');
  if (canConfirmPrinted && previous.confirmedPrintedAt) return previous;
  await writeControl(createBle630KCommand('resolve', id, outcome));
  return reconcile(id);
}

export function watchBluetooth630K(listener: Listener): () => void {
  listeners.add(listener);
  try { listener(getBluetooth630KState()); } catch { /* Isolate UI listeners. */ }
  return () => { listeners.delete(listener); };
}
export function getBluetooth630KState(): Bluetooth630KState {
  const state: Bluetooth630KState = { connected, error: currentError };
  if (printer) state.printer = { ...printer };
  if (currentJob) state.job = { ...currentJob };
  else {
    const pending = activeJob();
    if (pending) {
      const attempt = readBluetooth630KJobAttempt(pending.id);
      if (attempt) state.job = {
        v: 1, id: attempt.id, status: 'uncertain',
        message: '原蓝牙打印任务等待查询', updatedAt: attempt.updatedAt
      };
    }
  }
  return state;
}
export { Ble630KNotFoundError, readBluetooth630KPending };
