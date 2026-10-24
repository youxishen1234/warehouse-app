#!/usr/bin/env node
// K3 USB transport over the printer's USB serial port (COM3).
// Serial I/O lives in a small PowerShell child process so no native npm module
// or vendor driver is required.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const {
  COMMAND, MODELS, FrameParser, frame, encodeRows, errorName, parseStatus, parseHeartbeat,
} = require('./k3-protocol.cjs');

const BRIDGE = path.join(__dirname, 'k3-serial.ps1');
const TRACE_LIMIT = 400;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log() {
  if (process.env.K3_TRACE === '1') process.stderr.write('[k3] ' + Array.from(arguments).join(' ') + '\n');
}

class K3Error extends Error {
  constructor(message, { code = 'K3_ERROR', uncertain = false, retryable = false } = {}) {
    super(message);
    this.name = 'K3Error';
    this.code = code;
    this.uncertain = uncertain;
    this.retryable = retryable;
  }
}

function isKnownPrintStartFailure(error) {
  return error && ['PRINT_START_REJECTED', 'UNSUPPORTED', 'PRINTER_ERROR'].includes(error.code);
}

function resolvePowerShell() {
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    const result = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
      windowsHide: true, encoding: 'utf8', timeout: 15000,
    });
    if (result.status === 0) return candidate;
  }
  throw new K3Error('找不到可用的 PowerShell', { code: 'NO_POWERSHELL' });
}

/** Serial port bridge: JSON lines to k3-serial.ps1. */
class SerialBridge {
  constructor({ port = process.env.K3_PORT || 'COM3', baud = 115200, powershell = null } = {}) {
    this.port = port;
    this.baud = baud;
    this.powershell = powershell || resolvePowerShell();
    this.child = null;
    this.pending = [];
    this.queue = Promise.resolve();
    this.closed = false;
  }

  start() {
    if (this.child) return this;
    this.closed = false;
    const child = spawn(this.powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', BRIDGE, '-PortName', this.port, '-BaudRate', String(this.baud),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      const request = this.pending.shift();
      if (!request) { log('unexpected bridge output', line.slice(0, TRACE_LIMIT)); return; }
      let parsed;
      try { parsed = JSON.parse(line); } catch (error) {
        request.reject(new K3Error('串口桥返回了无法解析的数据', { code: 'BRIDGE_PROTOCOL' }));
        return;
      }
      if (!parsed.ok) { request.reject(new K3Error(String(parsed.error || '串口读写失败'), { code: 'BRIDGE_ERROR' })); return; }
      request.resolve(parsed);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => log('bridge stderr', chunk.trim().slice(0, TRACE_LIMIT)));
    child.once('exit', code => {
      const pending = this.pending.splice(0);
      this.child = null;
      for (const request of pending) request.reject(new K3Error(`串口进程已退出（${code}）`, { code: 'BRIDGE_EXIT' }));
      if (!this.closed) log('serial bridge exited', code);
    });
    child.once('error', error => {
      const pending = this.pending.splice(0);
      this.child = null;
      for (const request of pending) request.reject(new K3Error(`无法启动串口进程：${error.message}`, { code: 'BRIDGE_START' }));
    });
    return this;
  }

  request(message) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.child) this.start();
      this.pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(message) + '\n');
    });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async close() {
    this.closed = true;
    if (!this.child) return;
    const child = this.child;
    try { child.stdin.write(JSON.stringify({ op: 'close' }) + '\n'); } catch { /* already gone */ }
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      sleep(1500),
    ]);
    if (child.exitCode === null) { try { child.kill(); } catch { /* best effort */ } }
    this.child = null;
  }
}

/**
 * Protocol-level client. `transport` needs `write(buffer)` and `drain()`.
 * For tests a fake transport can answer synchronously.
 */
class K3Client {
  constructor(transport, { timeoutMs = 2500, printTimeoutMs = 90000, now = () => Date.now() } = {}) {
    this.transport = transport;
    this.parser = new FrameParser();
    this.timeoutMs = timeoutMs;
    this.printTimeoutMs = printTimeoutMs;
    this.now = now;
    this.events = [];
  }

  async send(command, payload = [], { prefix = false, expect = null, timeoutMs = this.timeoutMs, allowUnsupported = false } = {}) {
    const packet = frame(command, payload, { prefix });
    const deadline = Date.now() + timeoutMs;
    log('>>', packet.toString('hex'));
    let frames;
    const collect = bytes => {
      const parsed = this.parser.push(bytes);
      for (const item of parsed) {
        if (item.command === 0xe0 || item.command === 0xdb || item.command === 0xd3) this.events.push(item);
      }
      return parsed;
    };
    let response = await this.transport.write(packet, expect, timeoutMs);
    frames = collect(response);
    for (;;) {
      // Hardware errors take precedence over an acknowledgement in the same
      // serial batch. Otherwise a coalesced success+fault could be reported as
      // a successful command.
      const bad = frames.find(item => item.command === 0xdb);
      if (bad) throw new K3Error(`打印机报错：${errorName(bad.payload[0])}`, { code: 'PRINTER_ERROR' });
      const found = expect === null ? null : frames.find(item => item.command === expect);
      if (found) return found;
      const unsupported = frames.find(item => item.command === 0x00);
      if (unsupported) {
        if (allowUnsupported) return unsupported;
        throw new K3Error('打印机不支持该命令', { code: 'UNSUPPORTED' });
      }
      if (expect === null) return frames;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || typeof this.transport.read !== 'function') {
        throw new K3Error(`打印机无响应（等待 0x${expect.toString(16)}）`, { code: 'NO_RESPONSE' });
      }
      response = await this.transport.read(remainingMs);
      frames = collect(response);
      // Bridge reads block for their requested timeout. Yield briefly for
      // transports that return empty/partial chunks immediately, avoiding a
      // hot loop while still respecting the original command deadline.
      if (Date.now() < deadline) {
        await sleep(Math.min(deadline - Date.now(), 10));
      }
    }
  }

  async writeOnly(command, payload) {
    const packet = frame(command, payload);
    log('>>', packet.toString('hex'));
    await this.transport.writeOnly(packet);
  }

  async connect() {
    const response = await this.send(COMMAND.CONNECT, [0x01], { prefix: true, expect: 0xc2 });
    const status = response.payload[0];
    if (status === 0 || status >= 90) throw new K3Error(`打印机连接被拒绝（状态 ${status}）`, { code: 'CONNECT_REJECTED' });
    return { status, protocol: status === 3 ? 3 : status === 2 ? 2 : 1 };
  }

  async info(key, { optional = false } = {}) {
    const response = await this.send(COMMAND.PRINTER_INFO, [key], { expect: 0x40 + key, allowUnsupported: true });
    if (optional && response.command === 0x00) return undefined;
    return response.payload;
  }

  async density() { return (await this.info(1))[0]; }
  async speed() { const value = await this.info(2, { optional: true }); return value ? value[0] : null; }
  async labelType() { return (await this.info(3))[0]; }

  async heartbeat() {
    const response = await this.send(COMMAND.HEARTBEAT, [0x04], { expect: 0xd9 });
    return parseHeartbeat(response.payload);
  }

  async printStatus() {
    const response = await this.send(COMMAND.PRINT_STATUS, [0x01], { expect: 0xb3 });
    return parseStatus(response.payload);
  }

  async statusData() {
    const response = await this.send(COMMAND.PRINTER_STATUS_DATA, [0x01], { expect: 0xb5 });
    const data = response.payload;
    return {
      colourSupport: data.length > 10 ? data[10] : undefined,
      version: data.length > 12 ? data[11] * 100 + data[12] : undefined,
      raw: data.toString('hex'),
    };
  }

  async model() {
    const payload = await this.info(8);
    // K3 firmware answers key 8 with a single byte 0x13, meaning model 0x1300.
    const id = payload.length === 1 ? payload[0] << 8 : payload.readUInt16BE(0);
    return { id, name: MODELS[id] || `未知型号 ${id}` };
  }

  async firmware() {
    const payload = await this.info(9);
    return payload.length === 2 ? `${payload[0]}.${String(payload[1]).padStart(2, '0')}` : payload.toString('hex');
  }

  /** Wait for PrintEnd to return data[0] == 1. */
  async waitPrintEnd(deadline, onError) {
    for (;;) {
      const response = await this.send(COMMAND.PRINT_END, [0x01], { expect: 0xf4, timeoutMs: 1200 });
      if (response.payload[0] === 1) return true;
      if (response.payload[0] === 0 && this.now() < deadline) { await sleep(300); continue; }
      onError?.('PrintEnd 未确认');
      return false;
    }
  }

  /**
   * Best-effort close of a print session. A printer that never received
   * PrintEnd keeps the job open and rejects the next PrintStart as a paper
   * fault, so both packets are sent once. Failures are logged, never thrown,
   * and no page data is ever resent here.
   */
  async closeSession() {
    const steps = [];
    try {
      const reply = await this.send(COMMAND.CANCEL_PRINT, [0x01], { expect: 0xd0, timeoutMs: 1200 });
      steps.push(`cancel=${reply.payload.toString('hex')}`);
    } catch (error) {
      steps.push(`cancel-failed=${error.message}`);
    }
    try {
      const reply = await this.send(COMMAND.PRINT_END, [0x01], { expect: 0xf4, timeoutMs: 1200 });
      steps.push(`end=${reply.payload.toString('hex')}`);
    } catch (error) {
      steps.push(`end-failed=${error.message}`);
    }
    log('session cleanup', steps.join(' '));
    return steps;
  }

  /** Poll until the page sent by this job finishes. */
  async waitComplete({ totalPages, baseline, deadline, eventBase = 0 }) {
    let sawActivity = false;
    let last = null;
    const cumulativeTarget = baseline.page + totalPages;
    const countsThisJob = page => page === totalPages || page >= cumulativeTarget;
    while (this.now() < deadline) {
      // Only events after PageEnd belong to this page. Earlier page events are
      // leftovers from the previous job and must never complete this one.
      // The printer may number pages per job (starting again at 1) or keep a
      // lifetime counter; both are valid as long as the event covers this job.
      const pageEvent = this.events.slice(eventBase).find(item => item.command === 0xe0 && item.payload.length >= 2 &&
        countsThisJob(item.payload.readUInt16BE(0)));
      if (pageEvent) {
        const page = pageEvent.payload.readUInt16BE(0);
        return { method: 'page-event', page, status: last || await this.printStatus() };
      }
      let status;
      try { status = await this.printStatus(); } catch (error) {
        if (error && error.code === 'PRINTER_ERROR') throw error;
        log('status poll failed', error.message);
        await sleep(400);
        continue;
      }
      last = status;
      // A job only starts after PrintStart, which drops progress below 100.
      // A page counter that no longer matches the idle snapshot proves the
      // same thing. K3 firmware may keep feedProgress at 0 after the label is
      // out, so it is diagnostic only and must not gate completion.
      if (status.progress < 100 || status.page !== baseline.page) sawActivity = true;
      if (sawActivity && status.progress >= 100 && countsThisJob(status.page)) {
        return { method: 'poll', status };
      }
      await sleep(250);
    }
    return { method: 'timeout', status: last };
  }

  async print({ width, height, rowsBase64, copies = 1, density = 3, speed = 1, onProgress = () => {} }) {
    if (!Number.isInteger(copies) || copies < 1 || copies > 99) {
      throw new K3Error('打印份数无效（应为 1 到 99）', { code: 'INVALID_COPIES' });
    }
    // Never let a page event from the previous connection or job complete this one.
    this.events = [];
    // Configuration writes happen only after a successful handshake.
    await this.connect();
    const model = await this.model();
    if (model.id !== 4864) throw new K3Error(`当前连接的打印机不是 K3（型号 ${model.id}）`, { code: 'WRONG_MODEL' });
    const rows = Buffer.from(rowsBase64, 'base64');
    const rowBytes = Math.ceil(width / 8);
    if (rows.length !== rowBytes * height) throw new K3Error('位图尺寸与页高不符', { code: 'INVALID_BITMAP' });
    const baseline = await this.printStatus();
    onProgress({ phase: 'baseline', baseline });

    let started = false;
    let startUncertain = false;
    let sessionOpen = false;
    let endConfirmed = false;
    try {
      await this.send(COMMAND.SET_DENSITY, [density], { expect: 0x31 });
      await this.send(COMMAND.SET_LABEL_TYPE, [1], { expect: 0x33 });

      // K3 model metadata selects the V4 7-byte PrintStart layout, even when
      // the firmware reports protocol version 5.
      const start = Buffer.alloc(7);
      start.writeUInt16BE(copies, 0);
      start[6] = 0;
      // Mark the session as potentially open before waiting: the printer may
      // accept PrintStart even when its acknowledgement is lost.
      sessionOpen = true;
      let accepted;
      try {
        accepted = await this.send(COMMAND.PRINT_START, [...start], { expect: 0x02 });
      } catch (error) {
        if (isKnownPrintStartFailure(error)) throw error;
        startUncertain = true;
        throw error;
      }
      if (accepted.payload[0] !== 1) {
        throw new K3Error('打印机拒绝开始打印', { code: 'PRINT_START_REJECTED', retryable: true });
      }
      started = true;
      await this.send(COMMAND.PAGE_START, [1], { expect: 0x04 });
      const size = Buffer.alloc(6);
      size.writeUInt16BE(height, 0);
      size.writeUInt16BE(width, 2);
      size.writeUInt16BE(copies, 4);
      await this.send(COMMAND.SET_PAGE_SIZE, [...size], { expect: 0x14 });

      let sent = 0;
      let pending = [];
      let pendingBytes = 0;
      const flush = async () => {
        if (!pending.length) return;
        const batch = Buffer.concat(pending);
        pending = []; pendingBytes = 0;
        await this.transport.writeOnly(batch);
      };
      while (sent < height) {
        const band = Math.min(200, height - sent);
        const slice = rows.subarray(sent * rowBytes, (sent + band) * rowBytes);
        for (const packet of encodeRows(slice, width).packets) {
          const payload = Buffer.from(packet.payload);
          payload.writeUInt16BE(packet.row + sent, 0);
          const target = packet.type === 'empty' ? COMMAND.PRINT_EMPTY_ROW : COMMAND.PRINT_BITMAP_ROW;
          const bytes = frame(target, [...payload]);
          pending.push(bytes); pendingBytes += bytes.length;
          if (pendingBytes >= 3800) await flush();
        }
        sent += band;
        if (sent % 200 === 0 || sent === height) {
          await flush();
          const line = Math.max(0, sent - 1);
          await this.send(COMMAND.PRINT_CHECK_LINE, [line >> 8 & 0xff, line & 0xff, 0x01], { expect: 0xd3, timeoutMs: 6000 });
        }
        onProgress({ phase: 'rows', sent, height });
      }
      await flush();

      const eventBase = this.events.length;
      await this.send(COMMAND.PAGE_END, [1], { expect: 0xe4 });
      const deadline = this.now() + this.printTimeoutMs;
      const completion = await this.waitComplete({ totalPages: copies, baseline, deadline, eventBase });
      if (completion.method === 'timeout') {
        return {
          status: 'uncertain', pages: 0, sentRows: height,
          message: `打印机没有在 ${Math.round(this.printTimeoutMs / 1000)} 秒内确认出纸；请检查实机，勿自动重发`,
          pageBefore: baseline.page, pageAfter: completion.status?.page,
        };
      }
      // A page event is not enough by itself: the printer must also finish the
      // print session. Missing this receipt leaves the paper unconfirmed.
      const ended = await this.waitPrintEnd(deadline);
      if (!ended) {
        return {
          status: 'uncertain', pages: 0, sentRows: height,
          message: '打印机已报告页面完成，但结束回执未确认；请检查实际出纸，勿自动重发',
          pageBefore: baseline.page,
          pageAfter: completion.page ?? completion.status?.page,
        };
      }
      endConfirmed = true;
      sessionOpen = false;
      return {
        status: 'printed', pages: copies, sentRows: height,
        message: '打印机已确认该页完成', pageBefore: baseline.page,
        pageAfter: completion.page ?? completion.status?.page ?? baseline.page + copies,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (started || startUncertain) {
        // A missing PrintStart acknowledgement is just as ambiguous as a
        // later send failure: the printer may have accepted the session.
        return {
          status: 'uncertain', pages: 0,
          message: `${message}（${startUncertain ? 'PrintStart 回复不确定，可能已开始打印' : '已开始发送'}，请检查实际出纸，勿自动重发）`,
          pageBefore: baseline.page,
        };
      }
      if (isKnownPrintStartFailure(error)) {
        throw new K3Error(`${message}（未开始打印）`, { code: error.code, retryable: true });
      }
      throw new K3Error(`${message}（未开始打印）`, { code: error.code || 'PRINT_SETUP', retryable: true });
    } finally {
      // A rejected or half-finished session must be closed once, or the next
      // label is refused with a paper-feed error.
      if (sessionOpen && !endConfirmed) await this.closeSession();
    }
  }
}

class BridgeTransport {
  constructor(bridge) { this.bridge = bridge; }

  async write(packet, expect, timeoutMs = 800) {
    const response = await this.bridge.request({
      op: 'write', data: packet.toString('base64'), readTimeoutMs: timeoutMs,
    });
    const bytes = Buffer.from(response.data || '', 'base64');
    log('<<', bytes.toString('hex').slice(0, TRACE_LIMIT));
    return bytes;
  }

  async read(timeoutMs = 800) {
    const response = await this.bridge.request({ op: 'read', timeoutMs });
    const bytes = Buffer.from(response.data || '', 'base64');
    log('<<', bytes.toString('hex').slice(0, TRACE_LIMIT));
    return bytes;
  }

  async writeOnly(packet) {
    await this.bridge.request({ op: 'writeonly', data: packet.toString('base64') });
  }
}

async function readStatus(client) {
  const result = {};
  result.connect = await client.connect();
  result.model = await client.model();
  result.firmware = await client.firmware();
  result.density = await client.density();
  result.speed = await client.speed();
  result.labelType = await client.labelType();
  result.statusData = await client.statusData();
  result.heartbeat = await client.heartbeat();
  result.printStatus = await client.printStatus();
  return result;
}

function usage() {
  return [
    '用法:',
    '  node k3-serial.cjs status            读取型号/固件/浓度/纸张/心跳/打印状态',
    '  node k3-serial.cjs print <job.json>  发送一页标签（rowsBase64 为 1-bit MSB 行）',
    '  node k3-serial.cjs self-test         离线回放协议（不打开 COM3）',
  ].join('\n');
}

async function main(argv) {
  const command = argv[2];
  if (!command || command === '--help' || command === '-h') { process.stdout.write(usage() + '\n'); return; }
  if (command === 'self-test') {
    const { selfTest } = require('./k3-selftest.cjs');
    const result = await selfTest();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  const bridge = new SerialBridge({ port: process.env.K3_PORT || 'COM3' });
  try {
    const client = new K3Client(new BridgeTransport(bridge));
    if (command === 'status') {
      const status = await readStatus(client);
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      return;
    }
    if (command === 'print') {
      const file = argv[3];
      if (!file) throw new K3Error('请指定打印任务文件', { code: 'USAGE' });
      const job = JSON.parse(fs.readFileSync(file, 'utf8'));
      const width = Number(job.width), height = Number(job.height);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || width > 656 || height < 1 || height > 12000) {
        throw new K3Error('打印尺寸无效', { code: 'INVALID_JOB' });
      }
      const result = await client.print({
        width, height, rowsBase64: String(job.rowsBase64 || ''),
        copies: Number(job.copies) || 1, density: Number(job.density) || 3,
        onProgress: progress => log(JSON.stringify(progress)),
      });
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exitCode = result.status === 'printed' ? 0 : 3;
      return;
    }
    throw new K3Error(`未知命令：${command}`, { code: 'USAGE' });
  } finally {
    await bridge.close();
  }
}

module.exports = {
  K3Client, K3Error, SerialBridge, BridgeTransport, readStatus,
};

if (require.main === module) {
  main(process.argv).catch(error => {
    process.stderr.write((error && error.message) || String(error));
    process.stderr.write('\n');
    process.exitCode = error && error.retryable ? 2 : 1;
  });
}
