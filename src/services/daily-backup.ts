import { request } from './request';

export interface DailyBackupStatus {
  enabled: boolean;
  active: boolean;
  timeZone: 'Asia/Shanghai';
  hour: number;
  keepDays: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  nextScheduledAt: string | null;
  nextRetryAt: string | null;
  running: boolean;
  location: 'server';
  verified: boolean;
}

export interface DailyBackupExport {
  exportedAt: string;
  data: unknown;
}

const isDate = (value: unknown): value is string => typeof value === 'string' && /T.+(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(value) && Number.isFinite(Date.parse(value));
const isNullableDate = (value: unknown) => value === null || isDate(value);

export function validateDailyBackupStatus(value: unknown): DailyBackupStatus {
  const item = value as Partial<DailyBackupStatus> | null;
  if (!item || typeof item !== 'object' || Array.isArray(item)
    || !['enabled', 'active', 'running', 'verified'].every(key => typeof item[key] === 'boolean')
    || item.timeZone !== 'Asia/Shanghai' || item.location !== 'server'
    || !Number.isInteger(item.hour) || item.hour! < 0 || item.hour! > 23
    || !Number.isInteger(item.keepDays) || item.keepDays! < 1
    || ![item.lastSuccessAt, item.lastAttemptAt, item.nextScheduledAt, item.nextRetryAt].every(isNullableDate)
    || !(item.lastError === null || typeof item.lastError === 'string')) {
    throw new Error('服务器尚未提供有效的每日备份状态，请刷新或完成服务部署。');
  }
  return item as DailyBackupStatus;
}

export async function getDailyBackupStatus(): Promise<DailyBackupStatus> {
  const value = await request<unknown>({ url: '/api/backup/daily/status', method: 'GET', forceNetwork: true, timeout: 15000 });
  return validateDailyBackupStatus(value);
}

export async function getLatestDailyBackup(): Promise<DailyBackupExport> {
  const value = await request<unknown>({ url: '/api/backup/daily/latest', method: 'GET', forceNetwork: true, timeout: 120000 });
  const item = value as Partial<DailyBackupExport> | null;
  if (!item || typeof item !== 'object' || Array.isArray(item) || !isDate(item.exportedAt)
    || !item.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
    throw new Error('服务器返回的备份文件不完整，未下载。请刷新状态后重试。');
  }
  return item as DailyBackupExport;
}

/** Display server instants in Beijing time, independently of the device timezone. */
export function formatDailyBackupTime(value: string | null): string {
  if (!value || !isDate(value)) return '暂无';
  const beijing = new Date(Date.parse(value) + 8 * 60 * 60 * 1000);
  return beijing.toISOString().slice(0, 19).replace('T', ' ') + '（北京时间）';
}
