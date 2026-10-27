import Taro from '@tarojs/taro';

export const REMOTE_PRINT_PENDING_KEY = 'warehouse_remote_print_pending_v1';
export const BLUETOOTH_630K_PENDING_KEY = 'warehouse_bluetooth_630k_active_job_v1';
export type PendingRemotePrint = { id: string; noteId: number };
export type PendingBluetooth630KPrint = { id: string; deviceId?: string; relayId?: string };
const JOB_ID = /^[a-zA-Z0-9-]{16,100}$/;

function readPending(key: string, strict: boolean): unknown {
  try { return Taro.getStorageSync(key); }
  catch {
    if (strict) throw new Error('打印记录读取失败，请恢复本机存储后再打印');
    return undefined;
  }
}
function invalidPending(strict: boolean): undefined {
  if (strict) throw new Error('存在无法识别的原打印记录，请先核对原任务');
  return undefined;
}

export function readRemotePrintPending(strict = false): PendingRemotePrint | undefined {
  const value: any = readPending(REMOTE_PRINT_PENDING_KEY, strict);
  if (value === undefined || value === null || value === '') return undefined;
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !JOB_ID.test(value.id) ||
    !Number.isSafeInteger(value.noteId) || value.noteId <= 0) return invalidPending(strict);
  return { id: value.id, noteId: value.noteId };
}

export function readBluetooth630KPending(strict = false): PendingBluetooth630KPrint | undefined {
  const value: any = readPending(BLUETOOTH_630K_PENDING_KEY, strict);
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return JOB_ID.test(value) ? { id: value } : invalidPending(strict);
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !JOB_ID.test(value.id)) return invalidPending(strict);
  return { id: value.id,
    ...(typeof value.deviceId === 'string' ? { deviceId: value.deviceId } : {}),
    ...(typeof value.relayId === 'string' ? { relayId: value.relayId } : {}) };
}
