import type { DotMatrixSettings, PrintDocument } from '@/utils/dot-matrix-print';

export const BLE_630K_SERVICE_UUID = '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f021';
export const BLE_630K_CONTROL_UUID = '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f022';
export const BLE_630K_INFO_UUID = '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f023';
export const BLE_630K_DATA_UUID = '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f024';
export const BLE_630K_STATUS_UUID = '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f025';
export const BLE_630K_MAX_PAYLOAD = 512 * 1024;
export const BLE_630K_MAX_CHUNK = 180;
export const BLE_630K_CONTROL_MAX_BYTES = 4096;
export const BLE_630K_CONTROL_HEADER_BYTES = 9;
export const BLE_630K_CONTROL_MAGIC = 0xb6;

export type Ble630KJobStatus = 'received' | 'processing' | 'queued' | 'failed' | 'uncertain';
export type Ble630KJob = {
  v: 1;
  id: string;
  status: Ble630KJobStatus;
  message: string;
  updatedAt: number;
  confirmedPrintedAt?: number;
  code?: string;
};
export type Ble630KPrinter = { deviceId: string; relayId: string; name: string };
export type Ble630KJobInput = { id: string; document: PrintDocument; settings: DotMatrixSettings };
export type Ble630KRelayInfo = {
  v: 1;
  relayId: string;
  name: string;
  maxPayload: number;
  chunkSize: number;
};

const JOB_STATUSES: Ble630KJobStatus[] = ['received', 'processing', 'queued', 'failed', 'uncertain'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_ID = /^[a-zA-Z0-9-]{16,100}$/;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strictKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key));
}

function parseJson(value: unknown, label: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw new Error(`${label} JSON 无效`); }
  }
  if (!record(parsed)) throw new Error(`${label} 格式无效`);
  return parsed;
}

export class Ble630KNotFoundError extends Error {
  readonly code = 'JOB_NOT_FOUND';
  constructor(readonly jobId: string) {
    super(`打印电脑上没有任务 ${jobId}`);
    this.name = 'Ble630KNotFoundError';
  }
}

export function isBle630KNotFound(error: unknown): error is Ble630KNotFoundError {
  return error instanceof Ble630KNotFoundError ||
    (record(error) && error.code === 'JOB_NOT_FOUND' && typeof error.jobId === 'string');
}

export function validateBle630KRelayInfo(value: unknown): Ble630KRelayInfo {
  const info = parseJson(value, '打印电脑信息');
  if (!strictKeys(info, ['v', 'relayId', 'name', 'maxPayload', 'chunkSize']) ||
    info.v !== 1 || typeof info.relayId !== 'string' || !UUID.test(info.relayId) ||
    typeof info.name !== 'string' || !info.name.trim() || info.name.length > 80 ||
    !Number.isSafeInteger(info.maxPayload) || (info.maxPayload as number) <= 0 ||
    (info.maxPayload as number) > BLE_630K_MAX_PAYLOAD ||
    !Number.isSafeInteger(info.chunkSize) || (info.chunkSize as number) <= 0 ||
    (info.chunkSize as number) > BLE_630K_MAX_CHUNK) {
    throw new Error('打印电脑信息版本或参数无效');
  }
  return info as unknown as Ble630KRelayInfo;
}

export function validateBle630KJob(value: unknown, expectedId?: string): Ble630KJob {
  const job = parseJson(value, '打印状态');
  if (job.code === 'JOB_NOT_FOUND') {
    const keysOk = strictKeys(job, ['v', 'id', 'status', 'message', 'updatedAt', 'code']);
    if (!keysOk || job.v !== 1 || typeof job.id !== 'string' || !JOB_ID.test(job.id) ||
      job.status !== 'failed' || typeof job.message !== 'string' || job.message.length > 4096 ||
      !Number.isSafeInteger(job.updatedAt) || (job.updatedAt as number) < 0) {
      throw new Error('打印状态格式无效');
    }
    if (expectedId && job.id !== expectedId) throw new Error('打印电脑返回了其他任务的状态');
    throw new Ble630KNotFoundError(job.id);
  }
  const allowed = ['v', 'id', 'status', 'message', 'updatedAt'];
  if (!strictKeys(job, allowed, ['confirmedPrintedAt', 'code']) || job.v !== 1 ||
    typeof job.id !== 'string' || !JOB_ID.test(job.id) ||
    typeof job.status !== 'string' || !JOB_STATUSES.includes(job.status as Ble630KJobStatus) ||
    typeof job.message !== 'string' || job.message.length > 4096 ||
    !Number.isSafeInteger(job.updatedAt) || (job.updatedAt as number) < 0 ||
    (job.code !== undefined && (typeof job.code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(job.code))) ||
    (job.confirmedPrintedAt !== undefined &&
      (!Number.isSafeInteger(job.confirmedPrintedAt) || (job.confirmedPrintedAt as number) < 0))) {
    throw new Error('打印状态格式无效');
  }
  if (expectedId && job.id !== expectedId) throw new Error('打印电脑返回了其他任务的状态');
  return job as unknown as Ble630KJob;
}

/**
 * Frames a control command for BLE characteristics whose write values do not
 * support automatic long writes. Each frame carries the command ID, byte total,
 * offset, and payload size in network byte order.
 */
export function frameBle630KControl(command: string | Uint8Array, commandId: number, mtu: number): Uint8Array[] {
  const bytes = typeof command === 'string' ? new TextEncoder().encode(command) : command;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > BLE_630K_CONTROL_MAX_BYTES ||
    !Number.isSafeInteger(commandId) || commandId < 0 || commandId > 0xffff ||
    !Number.isSafeInteger(mtu) || mtu < 23) {
    throw new Error('蓝牙控制命令分帧参数无效');
  }
  const payloadSize = mtu - 3 - BLE_630K_CONTROL_HEADER_BYTES;
  if (payloadSize < 11) throw new Error('蓝牙 MTU 不足以发送控制帧');
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += payloadSize) {
    const length = Math.min(payloadSize, bytes.length - offset);
    const frame = new Uint8Array(BLE_630K_CONTROL_HEADER_BYTES + length);
    const view = new DataView(frame.buffer);
    frame[0] = BLE_630K_CONTROL_MAGIC;
    view.setUint16(1, commandId, false);
    view.setUint16(3, bytes.length, false);
    view.setUint16(5, offset, false);
    view.setUint16(7, length, false);
    frame.set(bytes.subarray(offset, offset + length), BLE_630K_CONTROL_HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}


export function mayTransferBle630KJob(job: Ble630KJob): boolean {
  return job.status === 'failed';
}

function hasNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(hasNull);
  return record(value) && Object.values(value).some(hasNull);
}

export function encodeBle630KEnvelope(input: Ble630KJobInput): Uint8Array {
  if (!input || !JOB_ID.test(input.id) || !record(input.document) || !record(input.settings)) {
    throw new Error('打印任务资料无效');
  }
  const json = JSON.stringify({ v: 1, job: { id: input.id, document: input.document, settings: input.settings } });
  if (typeof json !== 'string') throw new Error('打印任务资料无法编码');
  const parsed = JSON.parse(json);
  if (hasNull(parsed) || Object.keys(parsed).length !== 2 || Object.keys(parsed.job).length !== 3) {
    throw new Error('打印任务含有不支持的空值或字段');
  }
  const bytes = new TextEncoder().encode(json);
  if (bytes.length === 0 || bytes.length > BLE_630K_MAX_PAYLOAD) throw new Error('打印任务超过 512 KiB');
  return bytes;
}

export function createBle630KBegin(id: string, length: number, sha256: string, paper: string): string {
  if (!JOB_ID.test(id) || !Number.isSafeInteger(length) || length <= 0 || length > BLE_630K_MAX_PAYLOAD ||
    !/^[a-f0-9]{64}$/.test(sha256) || typeof paper !== 'string' || !paper.trim() || paper.length > 32) {
    throw new Error('打印任务开始参数无效');
  }
  return JSON.stringify({ v: 1, op: 'begin', id, length, sha256, paper });
}

export function createBle630KCommand(op: 'hello' | 'commit' | 'status' | 'resolve', id?: string, outcome?: 'printed' | 'missing'): string {
  if (op === 'hello') return JSON.stringify({ v: 1, op });
  if (!id || !JOB_ID.test(id)) throw new Error('打印任务编号无效');
  if (op === 'resolve') {
    if (outcome !== 'printed' && outcome !== 'missing') throw new Error('打印核对结果无效');
    return JSON.stringify({ v: 1, op, id, outcome });
  }
  return JSON.stringify({ v: 1, op, id });
}

export function frameBle630KData(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > BLE_630K_MAX_PAYLOAD ||
    !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > BLE_630K_MAX_CHUNK) {
    throw new Error('打印资料分块参数无效');
  }
  const frames: Uint8Array[] = [];
  for (let offset = 0, ordinal = 0; offset < bytes.length; offset += chunkSize, ordinal++) {
    const length = Math.min(chunkSize, bytes.length - offset);
    const frame = new Uint8Array(length + 4);
    new DataView(frame.buffer).setUint32(0, ordinal, false);
    frame.set(bytes.subarray(offset, offset + length), 4);
    frames.push(frame);
  }
  return frames;
}

const SHA256_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
const rotateRight = (value: number, count: number) => (value >>> count) | (value << (32 - count));

export function sha256HexFallback(input: Uint8Array): string {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high, false);
  view.setUint32(paddedLength - 4, low, false);
  const state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choice + SHA256_K[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }
  return Array.from(state, value => value.toString(16).padStart(8, '0')).join('');
}

export async function sha256Hex(input: Uint8Array): Promise<string> {
  const subtle = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto.subtle : undefined;
  if (subtle) {
    try {
      const bytes = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
      const digest = await subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    } catch { /* Some embedded WebViews expose a disabled SubtleCrypto. */ }
  }
  return sha256HexFallback(input);
}
