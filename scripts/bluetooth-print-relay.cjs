const http = require('node:http');
const { createHash, timingSafeEqual } = require('node:crypto');
const { validatePrintJob } = require('./dot-matrix-native.cjs');

const MAX_JOB_BYTES = 512 * 1024;
const CHUNK_BYTES = 180;
const JOB_ID = /^[a-zA-Z0-9-]{16,100}$/;
const STATUSES = new Set(['received', 'processing', 'queued', 'failed', 'uncertain']);

function relayError(message, code, statusCode = 400, safeToRetry = true) {
  return Object.assign(new Error(message), { code, statusCode, safeToRetry });
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw relayError(`${label}格式无效`, 'INVALID_ENVELOPE');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw relayError(`${label}包含不支持的字段`, 'INVALID_ENVELOPE');
  }
}

/**
 * The phone supplies document data only. The Windows receiver owns the printer
 * name and validates the same bounded shape used by its native HTTPS path.
 */
function validateBleEnvelope(value, printerName) {
  exactObject(value, ['v', 'job'], '蓝牙打印任务');
  if (value.v !== 1) throw relayError('蓝牙打印协议版本无效', 'INVALID_ENVELOPE');
  exactObject(value.job, ['id', 'document', 'settings'], '蓝牙打印资料');
  if (!JOB_ID.test(value.job.id || '')) throw relayError('蓝牙打印任务编号无效', 'INVALID_JOB');
  let job;
  try {
    job = validatePrintJob({
      id: value.job.id,
      printerName,
      document: value.job.document,
      settings: value.job.settings,
    });
  } catch (error) {
    throw relayError(error.message || '蓝牙打印资料无效', error.code || 'INVALID_JOB', 400, error.safeToRetry !== false);
  }
  if (job.settings.template !== 'delivery-note' || !['241-93', '241-140', 'a4'].includes(job.settings.paper)) {
    throw relayError('蓝牙打印纸张无效', 'INVALID_JOB');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_JOB_BYTES) {
    throw relayError('蓝牙打印任务超过 512 KiB', 'JOB_TOO_LARGE');
  }
  return job;
}

function publicBleJob(row) {
  if (!row) throw relayError('蓝牙打印任务不存在', 'JOB_NOT_FOUND', 404, true);
  const status = STATUSES.has(row.status) ? row.status : 'uncertain';
  return {
    v: 1,
    id: row.id,
    status,
    message: String(row.message || '打印状态未确认').slice(0, 200),
    updatedAt: Number(row.updatedAt) || Date.now(),
    ...(Number.isFinite(row.confirmedPrintedAt) ? { confirmedPrintedAt: row.confirmedPrintedAt } : {}),
  };
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function responseJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function responseData(response, statusCode, data) {
  responseJson(response, statusCode, { success: true, data });
}

function responseError(response, error) {
  responseJson(response, Number(error?.statusCode) || 500, {
    success: false,
    code: String(error?.code || 'BLE_RELAY_ERROR'),
    message: String(error?.message || '蓝牙打印中继暂不可用').slice(0, 500),
    safeToRetry: error?.safeToRetry === true,
  });
}

function readBody(request, limit = MAX_JOB_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(relayError('蓝牙打印任务超过 512 KiB', 'JOB_TOO_LARGE', 413));
      request.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(relayError('蓝牙打印任务超过 512 KiB', 'JOB_TOO_LARGE', 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function createRelayServer({ journal, printerName, capability }) {
  if (!journal || typeof journal.reserveBle !== 'function') throw new TypeError('journal.reserveBle is required');
  if (typeof printerName !== 'string' || !printerName.trim()) throw new TypeError('printerName is required');
  if (typeof capability !== 'string' || capability.length < 32) throw new TypeError('a local relay capability is required');

  const server = http.createServer(async (request, response) => {
    try {
      const remote = request.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
        throw relayError('仅允许本机蓝牙中继访问', 'LOCAL_ONLY', 403, false);
      }
      if (!sameSecret(request.headers['x-warehouse-ble-relay'], capability)) {
        throw relayError('本机蓝牙中继凭据无效', 'UNAUTHORIZED', 401, false);
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/v1/health' && request.method === 'GET') {
        responseData(response, 200, { relay: '630K', ready: true });
        return;
      }
      if (url.pathname === '/v1/jobs' && request.method === 'POST') {
        const body = await readBody(request);
        let envelope;
        try { envelope = JSON.parse(body.toString('utf8')); }
        catch { throw relayError('蓝牙打印任务不是有效 JSON', 'INVALID_ENVELOPE'); }
        const job = validateBleEnvelope(envelope, printerName);
        const row = journal.reserveBle(job);
        responseData(response, row.created === false ? 200 : 202, publicBleJob(row));
        return;
      }
      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([a-zA-Z0-9-]{16,100})$/);
      if (jobMatch && request.method === 'GET') {
        responseData(response, 200, publicBleJob(journal.bleStatus(jobMatch[1])));
        return;
      }
      const resolveMatch = url.pathname.match(/^\/v1\/jobs\/([a-zA-Z0-9-]{16,100})\/resolve$/);
      if (resolveMatch && request.method === 'POST') {
        const body = await readBody(request, 4096);
        let input;
        try { input = JSON.parse(body.toString('utf8')); }
        catch { throw relayError('核对结果格式无效', 'INVALID_RESOLUTION'); }
        if (!input || !['printed', 'missing'].includes(input.outcome) || Object.keys(input).length !== 1) {
          throw relayError('请说明实际是否出纸', 'INVALID_RESOLUTION');
        }
        responseData(response, 200, publicBleJob(journal.resolveBle(resolveMatch[1], input.outcome)));
        return;
      }
      throw relayError('本机蓝牙中继接口不存在', 'NOT_FOUND', 404, false);
    } catch (error) {
      if (!response.headersSent) responseError(response, error);
      else response.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

async function listenRelayServer(server) {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('蓝牙中继本机接口启动失败');
  return `http://127.0.0.1:${address.port}`;
}

function createBleRelay({ journal, service, printerName, capability, withPrinter = task => task() }) {
  const server = createRelayServer({ journal, printerName, capability });
  let address = '';
  let active;
  let stopped = false;

  const tick = async () => {
    if (stopped || active) return active;
    active = withPrinter(async () => {
      const row = journal.nextBle();
      if (!row) return null;
      journal.startBle(row.id);
      try {
        // A deliberate retry is a new renderer attempt, but the phone's id
        // remains the durable replay key. Never reuse a cached failed promise.
        const attemptId = 'ble-' + createHash('sha256').update(row.id + ':' + (row.attempt || 1)).digest('hex');
        const result = await service.submit({ ...row.payload, id: attemptId });
        const complete = result?.kind === 'queued'
          ? { status: 'queued', message: '已送入630K打印队列，请以实际出纸为准' }
          : { status: 'failed', message: '未发送到实体打印机' };
        journal.finishBle(row.id, complete);
      } catch (error) {
        journal.finishBle(row.id, {
          status: error?.safeToRetry === true ? 'failed' : 'uncertain',
          message: String(error?.message || '打印电脑处理中断，请检查实际出纸').slice(0, 200),
        });
      }
      return journal.bleStatus(row.id);
    }).finally(() => { active = undefined; });
    return active;
  };

  return {
    async start() {
      address = await listenRelayServer(server);
      return address;
    },
    address: () => address,
    tick,
    status: id => publicBleJob(journal.bleStatus(id)),
    async stop() {
      stopped = true;
      if (active) await active.catch(() => {});
      if (!server.listening) return;
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = {
  MAX_JOB_BYTES,
  CHUNK_BYTES,
  validateBleEnvelope,
  publicBleJob,
  createRelayServer,
  listenRelayServer,
  createBleRelay,
  relayError,
};
