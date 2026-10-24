// Pure NIIMBOT framing/encoding helpers. No I/O: everything here is
// deterministic so the same code runs in the agent and in the protocol tests.

const HEAD = 0x55;
const TAIL = 0xaa;

const COMMAND = Object.freeze({
  PRINT_START: 0x01,
  PAGE_START: 0x03,
  SET_PAGE_SIZE: 0x13,
  PRINT_QUANTITY: 0x15,
  PRINT_CLEAR: 0x20,
  SET_DENSITY: 0x21,
  SET_LABEL_TYPE: 0x23,
  PRINT_BITMAP_ROW: 0x85,
  PRINT_BITMAP_ROW_INDEXED: 0x83,
  PRINT_EMPTY_ROW: 0x84,
  PRINT_CHECK_LINE: 0x86,
  PAGE_END: 0xe3,
  PRINT_END: 0xf3,
  CANCEL_PRINT: 0xda,
  PRINTER_INFO: 0x40,
  PRINTER_STATUS_DATA: 0xa5,
  PRINT_STATUS: 0xa3,
  HEARTBEAT: 0xdc,
  CONNECT: 0xc1,
});

const ERROR_NAMES = Object.freeze({
  0x01: '上盖未关闭',
  0x02: '标签纸已用完',
  0x03: '电量过低',
  0x04: '电池异常',
  0x05: '已在打印机上取消',
  0x06: '打印数据异常',
  0x07: '打印头过热',
  0x08: '走纸异常',
  0x09: '打印机忙',
  0x0a: '打印头未连接',
  0x0b: '环境温度过低',
  0x0c: '打印头未装好',
  0x0d: '缺少碳带',
  0x0e: '碳带类型不匹配',
  0x0f: '碳带已用完',
  0x10: '标签纸类型不匹配',
  0x11: '打印机拒绝该标签纸类型',
  0x12: '打印机拒绝该打印模式',
  0x13: '打印机拒绝该浓度',
  0x14: '写标签 RFID 失败',
  0x15: '打印机拒绝该边距',
  0x16: '通信中断',
  0x17: '打印机已断开',
  0x18: '画布参数错误',
  0x19: '旋转参数错误',
  0x1a: '打印参数格式错误',
  0x1b: 'B3S 出纸异常',
  0x1c: '需要检查标签纸',
  0x1d: '标签 RFID 无数据',
  0x1e: '不支持设置浓度',
  0x1f: '不支持该打印模式',
  0x20: '标签材质错误',
  0x21: '不支持该标签材质',
  0x22: '该机型不支持写 RFID',
  0x32: '标签页参数无效',
  0x33: '碳带页参数无效',
  0x34: '打印机等待数据超时',
  0x35: '碳带不是正品',
});

function errorName(code) {
  const value = Number.isInteger(code) ? code : -1;
  return ERROR_NAMES[value] || `打印机错误 0x${(value & 0xff).toString(16).padStart(2, '0').toUpperCase()}`;
}

function bcc(command, payload) {
  let value = command ^ payload.length;
  for (const byte of payload) value ^= byte;
  return value & 0xff;
}

function frame(command, payload = [], { prefix = false } = {}) {
  const body = Buffer.from(payload);
  if (!Number.isInteger(command) || command < 0 || command > 0xff) throw new RangeError('command out of range');
  if (body.length > 255) throw new RangeError('payload too long');
  const head = prefix ? Buffer.from([0x03]) : Buffer.alloc(0);
  return Buffer.concat([
    head,
    Buffer.from([HEAD, HEAD, command, body.length]),
    body,
    Buffer.from([bcc(command, body), TAIL, TAIL]),
  ]);
}

/**
 * Incremental parser. Serial data may split frames anywhere or merge several
 * frames plus unsolicited events into one read.
 */
class FrameParser {
  constructor() { this.buffer = Buffer.alloc(0); }

  push(chunk) {
    if (!chunk || !chunk.length) return [];
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames = [];
    for (;;) {
      // Discard garbage until a plausible header.
      let start = -1;
      for (let index = 0; index + 1 < this.buffer.length; index += 1) {
        if (this.buffer[index] === HEAD && this.buffer[index + 1] === HEAD) { start = index; break; }
      }
      if (start < 0) {
        // Keep a trailing 0x55; it may be the first byte of the next header.
        this.buffer = this.buffer.length && this.buffer[this.buffer.length - 1] === HEAD
          ? this.buffer.subarray(this.buffer.length - 1) : Buffer.alloc(0);
        break;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);
      if (this.buffer.length < 4) break;
      const length = this.buffer[3];
      const total = length + 7;
      if (this.buffer.length < total) {
        // Garbage can itself contain "55 55" and imply a huge length. If a
        // complete valid frame starts at a later header, trust that one.
        let rescue = -1;
        for (let index = 0; index + 3 < this.buffer.length; index += 1) {
          if (this.buffer[index] !== HEAD || this.buffer[index + 1] !== HEAD) continue;
          const candidateLength = this.buffer[index + 3];
          const candidateTotal = candidateLength + 7;
          if (index + candidateTotal > this.buffer.length) continue;
          const body = this.buffer.subarray(index + 4, index + 4 + candidateLength);
          if (this.buffer[index + candidateTotal - 2] === TAIL &&
              this.buffer[index + candidateTotal - 1] === TAIL &&
              this.buffer[index + 4 + candidateLength] === bcc(this.buffer[index + 2], body)) {
            rescue = index; break;
          }
        }
        if (rescue > 0) { this.buffer = this.buffer.subarray(rescue); continue; }
        break;
      }
      const candidate = this.buffer.subarray(0, total);
      const command = candidate[2];
      const payload = candidate.subarray(4, 4 + length);
      const checksum = bcc(command, payload);
      const valid = candidate[total - 2] === TAIL && candidate[total - 1] === TAIL &&
        candidate[4 + length] === checksum;
      if (!valid) {
        // A bad frame must not swallow the next good header.
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      frames.push({ command, payload: Buffer.from(payload), raw: Buffer.from(candidate) });
      this.buffer = this.buffer.subarray(total);
    }
    if (this.buffer.length > 4096) this.buffer = Buffer.alloc(0);
    return frames;
  }
}

/** Split a 1-bit, MSB-first row bitmap into printer row packets. */
function encodeRows(rows, width, { rowBand = 0 } = {}) {
  if (!Buffer.isBuffer(rows)) throw new TypeError('rows must be a Buffer');
  if (!Number.isInteger(width) || width < 8 || width > 656) throw new RangeError('width out of range');
  const rowBytes = Math.ceil(width / 8);
  if (rows.length % rowBytes !== 0) throw new RangeError('bitmap length is not a whole number of rows');
  const height = rows.length / rowBytes;
  if (height < 1 || height > 12000) throw new RangeError('height out of range');
  const chunkBytes = Math.floor(656 / 8 / 3); // 27
  const packets = [];
  let row = 0;
  while (row < height) {
    const offset = row * rowBytes;
    const line = rows.subarray(offset, offset + rowBytes);
    const blank = line.every(byte => byte === 0);
    if (blank) {
      let count = 0;
      while (row + count < height && count < 255) {
        const next = (row + count) * rowBytes;
        if (rows.subarray(next, next + rowBytes).some(byte => byte !== 0)) break;
        count += 1;
      }
      const payload = Buffer.alloc(3);
      payload.writeUInt16BE(row, 0);
      payload[2] = count;
      packets.push({ type: 'empty', row, count, command: COMMAND.PRINT_EMPTY_ROW, payload });
      row += count;
      continue;
    }
    const counters = [0, 0, 0];
    for (let index = 0; index < line.length; index += 1) {
      const chunk = index < chunkBytes ? 0 : index < chunkBytes * 2 ? 1 : 2;
      counters[Math.min(chunk, 2)] += popcount(line[index]);
    }
    // Header is row(2) + three black-pixel counters + repeats, then the bitmap.
    const body = Buffer.alloc(6 + rowBytes);
    body.writeUInt16BE(row + rowBand, 0);
    body[2] = counters[0];
    body[3] = counters[1];
    body[4] = counters[2];
    body[5] = 1;
    line.copy(body, 6);
    packets.push({ type: 'bitmap', row, command: COMMAND.PRINT_BITMAP_ROW, payload: body });
    row += 1;
  }
  return { packets, height, width, rowBytes };
}

function popcount(byte) {
  let value = byte & 0xff;
  let count = 0;
  while (value) { value &= value - 1; count += 1; }
  return count;
}

function parseStatus(payload) {
  if (payload.length < 4) throw new RangeError('print status too short');
  // Only the first four bytes carry print state. Later bytes are firmware
  // fields: a K3 firmware reports 0x08 there while idle, so treating it as an
  // error code would turn a healthy printer into "paper feed fault".
  // Hardware faults arrive as an unsolicited 0xDB frame instead.
  return {
    page: payload.readUInt16BE(0),
    progress: payload[2],
    feedProgress: payload[3],
  };
}

function parseHeartbeat(payload) {
  if (payload.length < 9) throw new RangeError('heartbeat too short');
  return {
    battery: payload[2],
    temperature: payload[3],
    lidOpen: payload[4] !== 0,
    paperPresent: payload[5] === 0,
    paperRfid: payload[6] !== 0,
    ribbonRfid: payload[7] !== 0,
    ribbonPresent: payload[8] === 0,
    voltageState: payload.length >= 14 ? payload[13] : undefined,
  };
}

const MODELS = Object.freeze({ 4864: 'K3', 4865: 'K3 WiFi', 4868: 'K3 ITD' });

module.exports = {
  COMMAND, ERROR_NAMES, MODELS, FrameParser, bcc, frame, encodeRows, popcount,
  parseStatus, parseHeartbeat, errorName,
};
