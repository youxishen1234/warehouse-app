#!/usr/bin/env node
// Independent K3 label receiver. It uses the delivery agent only once to
// register a dedicated label token, then prints through COM3 without a Windows
// print queue. A job is complete only after the printer confirms the page.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { K3Client, SerialBridge, BridgeTransport } = require('./k3-serial.cjs');

const ORIGIN = 'https://youxishen.online';
const TOKEN = /^[a-f0-9]{64}$/;
const JOB_ID = /^[a-zA-Z0-9-]{16,100}$/;
const TERMINAL = new Set(['queued', 'failed']);

const atomicJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
};

const signatureOf = job => crypto.createHash('sha256').update(JSON.stringify({
  kind: job.kind, profile: job.profile, copies: job.copies, data: job.data ?? null
})).digest('hex');

function createJournal(file) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = { jobs: {} }; }
  if (!state || typeof state !== 'object' || !state.jobs || typeof state.jobs !== 'object') state = { jobs: {} };
  const save = () => atomicJson(file, state);
  return {
    entries: () => Object.values(state.jobs).filter(row => !row.acknowledged),
    get: id => state.jobs[id],
    save,
    begin(job) {
      const signature = signatureOf(job);
      const previous = state.jobs[job.id];
      if (previous) {
        if (previous.signature !== signature) throw new Error('任务编号重复且内容不同，已停止打印');
        return previous;
      }
      const row = { id: job.id, lease: job.lease, signature, at: Date.now() };
      state.jobs[job.id] = row;
      save();
      return row;
    },
    result(id, result) {
      const row = state.jobs[id];
      if (!row) throw new Error('任务日志缺失');
      row.result = result;
      row.at = Date.now();
      save();
      return row;
    },
    progress(id, sent, height) {
      const row = state.jobs[id];
      if (!row) return;
      row.progress = { sent, height, at: Date.now() };
      save();
    },
    acknowledged(id) {
      const row = state.jobs[id];
      if (!row) return;
      row.acknowledged = true;
      delete row.resultData;
      save();
    },
    // Keep a bounded history while never dropping an unacknowledged receipt.
    prune() {
      const rows = Object.values(state.jobs).sort((a, b) => b.at - a.at);
      rows.slice(300).forEach(row => {
        if (row.acknowledged) delete state.jobs[row.id];
      });
      save();
    }
  };
}

function apiCall(origin, token, url, body, { method = 'POST' } = {}) {
  return fetch(`${origin}/api/remote-print/labels/${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Print-Agent': token },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000)
  }).then(async response => {
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) {
      const error = new Error(result.message || `连接失败（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return result.data;
  });
}

async function register(configFile, config, { fetchImpl = fetch, log = () => {} } = {}) {
  if (!config.deliveryConfig) throw new Error('未配置送货单接收程序，无法登记标签通道');
  const deliveryFile = path.resolve(path.dirname(configFile), config.deliveryConfig);
  let delivery;
  try { delivery = JSON.parse(fs.readFileSync(deliveryFile, 'utf8')); }
  catch { throw new Error('读取送货单打印配置失败，请确认现有接收程序仍在原位'); }
  if (delivery.origin !== ORIGIN || !TOKEN.test(String(delivery.agent || ''))) {
    throw new Error('送货单打印配置无效，无法登记标签通道');
  }
  const headers = { 'Content-Type': 'application/json', 'X-Print-Agent': delivery.agent };
  const get = async url => {
    const response = await fetchImpl(`${ORIGIN}/api/remote-print/${url}`, {
      headers, signal: AbortSignal.timeout(15000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.success) throw new Error(body.message || `登记请求失败（HTTP ${response.status}）`);
    return body.data;
  };
  const deliveryDevice = await get('agent/device');
  if (!deliveryDevice || !deliveryDevice.id) throw new Error('送货单电脑身份无效');
  const response = await fetchImpl(`${ORIGIN}/api/remote-print/labels/register`, {
    method: 'POST', headers,
    body: JSON.stringify({ deviceId: deliveryDevice.id, name: deliveryDevice.name, printer: config.printer }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success) throw new Error(body.message || `标签通道登记失败（HTTP ${response.status}）`);
  const registered = body.data;
  if (!registered?.device || registered.device.id !== deliveryDevice.id || !TOKEN.test(String(registered.agent || ''))) {
    throw new Error('标签通道登记回执无效');
  }
  const next = { ...config, mode: 'paired', agent: registered.agent };
  atomicJson(configFile, next);
  log(`标签通道已登记：${registered.device.name}`);
  return next;
}

function safeId(id) {
  if (!JOB_ID.test(String(id || ''))) throw new Error('打印任务编号无效');
  return id;
}

function validBitmap(result) {
  if (!result || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height)) return '渲染尺寸无效';
  if (result.width < 80 || result.width > 656 || result.height < 80 || result.height > 12000) return '标签尺寸超出 K3 打印头';
  if (typeof result.rowsBase64 !== 'string' || !result.rowsBase64) return '渲染位图为空';
  const expected = Math.ceil(result.width / 8) * result.height;
  if (Buffer.from(result.rowsBase64, 'base64').length !== expected) return '位图行数与标签尺寸不符';
  if (!(result.blackPixels > 0) || !(result.pixelRatio > 0.001 && result.pixelRatio < 0.65)) {
    return '渲染结果近乎空白，已停止打印';
  }
  if (result.pngPath && (!fs.existsSync(result.pngPath) || fs.statSync(result.pngPath).size < 500)) return '标签预览图未生成';
  return '';
}

function createAgent({
  config, journal, client, render, call, outputDir,
  log = () => {}, readyProbe = async () => true, onBeat = () => {},
  now = () => Date.now(), printHeartbeatMs = 8000
}) {
  let active;
  let ready = false;
  let nextProbe = 0;
  let leaseBeat = 0;
  let stopping = false;

  const acknowledge = async row => {
    const result = row.result || {
      status: 'uncertain',
      message: '接收程序中断，请检查 K3 实际出纸，勿重复发送'
    };
    try {
      await call(`agent/jobs/${encodeURIComponent(row.id)}`, { lease: row.lease, ...result });
      journal.acknowledged(row.id);
      log(`回执已送达 ${row.id}：${result.status}`);
      return true;
    } catch (error) {
      // A 409 means the server lease already expired or the receipt was
      // recorded before the response was lost. Never send that job again.
      if (error.status === 409) {
        journal.acknowledged(row.id);
        log(`回执已失效或已记录 ${row.id}：${error.message}`);
        return true;
      }
      log(`回执失败 ${row.id}：${error.message}`);
      return false;
    }
  };

  const reconcile = async () => {
    let complete = true;
    for (const row of journal.entries()) {
      if (!await acknowledge(row)) complete = false;
    }
    return complete;
  };

  const execute = async job => {
    safeId(job.id);
    let row;
    try {
      row = journal.begin(job);
    } catch (error) {
      journal.result(job.id, { status: 'failed', message: error.message });
      await acknowledge(journal.get(job.id));
      return;
    }
    if (row.result) {
      await acknowledge(row);
      return;
    }
    const png = path.join(outputDir, `${job.id}.png`);
    let rendered;
    try {
      rendered = await render({
        kind: job.kind, data: job.data, profile: job.profile,
        copies: job.copies, calibration: job.kind === 'calibration', outputPng: png
      });
      if (rendered.warnings && rendered.warnings.length) {
        throw new Error(rendered.warnings.join('；').slice(0, 200));
      }
      const invalid = validBitmap(rendered);
      if (invalid) throw new Error(invalid);
    } catch (error) {
      journal.result(job.id, { status: 'failed', message: String(error.message || error).slice(0, 200) });
      log(`任务 ${job.id} 渲染失败：${error.message}`);
      await acknowledge(journal.get(job.id));
      return;
    }

    // The server treats a processing lease as alive only while the agent
    // polls. Sending 800 rows can take well over a minute, so keep this
    // heartbeat running independently of the print call and clear it on both
    // success and failure.
    const printHeartbeat = setInterval(() => {
      void call('agent/poll', { ready: false }).catch(error => log(`打印心跳失败：${error.message}`));
    }, printHeartbeatMs);
    try {
      const result = await client.print({
        width: rendered.width, height: rendered.height,
        rowsBase64: rendered.rowsBase64, copies: job.copies,
        density: job.profile.density || 3,
        onProgress: progress => {
          if (progress.phase === 'rows') journal.progress(job.id, progress.sent, progress.height);
        }
      });
      const receipt = result.status === 'printed'
        ? {
            status: 'queued',
            message: `K3 已确认出纸（页 ${result.pageBefore} → ${result.pageAfter}）`,
            pages: result.pages
          }
        : { status: 'uncertain', message: result.message || '打印结果未确认，请检查实际出纸，勿重复发送' };
      journal.result(job.id, receipt);
      log(`任务 ${job.id}：${receipt.status} ${receipt.message}`);
    } catch (error) {
      // print() only throws for failures before PrintStart. Anything after the
      // printer accepted the job is returned as uncertain, never retried here.
      journal.result(job.id, {
        status: 'failed',
        message: `发送前失败：${String(error.message || error).slice(0, 180)}`
      });
      log(`任务 ${job.id} 发送前失败：${error.message}`);
    } finally {
      clearInterval(printHeartbeat);
    }
    await acknowledge(journal.get(job.id));
  };

  const cycle = async () => {
    const reconciled = await reconcile();
    if (stopping) return;
    const at = now();
    if (at >= nextProbe) {
      try {
        ready = (await readyProbe()) === true;
        nextProbe = at + 20000;
      } catch (error) {
        ready = false;
        nextProbe = at + 5000;
        log(`K3 检测失败：${error.message}`);
      }
      log(`K3 就绪=${ready}`);
    }
    const claim = await call('agent/poll', { ready: reconciled && ready });
    if (claim.job) {
      leaseBeat = Date.now();
      await execute(claim.job);
      // A job always changes printer state (or leaves its session just closed).
      // Probe again before claiming the next label instead of reporting the
      // device unavailable until the regular 20 s readiness interval expires.
      nextProbe = 0;
      return;
    }
    if (Date.now() - leaseBeat > 8000) {
      leaseBeat = Date.now();
      await call('agent/poll', { ready: false }).catch(error => log(`心跳失败：${error.message}`));
    }
  };

  return {
    tick() {
      if (!active) {
        active = cycle().catch(error => log(`接收轮次失败：${error.message}`))
          .finally(() => { active = undefined; onBeat(); });
      }
      return active;
    },
    stop() { stopping = true; }
  };
}

function checkConfig(config) {
  if (!config || config.origin !== ORIGIN) throw new Error('标签接收程序只能连接正式站点');
  if (config.printer !== 'K3-I911020404') throw new Error('标签打印机型号配置无效');
  if (!/^COM[1-9][0-9]*$/.test(String(config.port || ''))) throw new Error('串口配置无效');
  if (!Number.isSafeInteger(config.baud) || config.baud < 9600 || config.baud > 921600) throw new Error('串口波特率无效');
}

async function acquireLock(configFile) {
  if (process.platform !== 'win32') {
    const file = path.join(path.dirname(configFile), 'k3-agent.lock');
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch { throw new Error('K3 标签接收程序已经运行'); }
    fs.writeFileSync(fd, String(process.pid));
    return () => { fs.closeSync(fd); try { fs.unlinkSync(file); } catch { /* best effort */ } };
  }
  const file = path.join(path.dirname(configFile), 'k3-agent.lock');
  const name = crypto.createHash('sha256').update(path.resolve(configFile).toLowerCase()).digest('hex');
  const server = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(error.code === 'EADDRINUSE'
      ? new Error('K3 标签接收程序已经运行') : error));
    server.listen(`\\\\.\\pipe\\warehouse-k3-label-${name}`, resolve);
  });
  try { fs.writeFileSync(file, String(process.pid), { mode: 0o600 }); }
  catch (error) { server.close(); throw error; }
  return () => {
    if (server.listening) server.close();
    try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch { /* best effort */ }
  };
}

async function main() {
  const configFile = path.resolve(process.argv[2] || path.join(__dirname, '..', 'k3-agent.json'));
  let config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  checkConfig(config);
  const root = path.dirname(configFile);
  const logFile = path.join(root, 'k3-receiver.log');
  const report = message => {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
        fs.renameSync(logFile, `${logFile}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
      }
      fs.appendFileSync(logFile, line + '\n');
    } catch { /* logging must not stop printing */ }
  };
  const releaseLock = await acquireLock(configFile);
  let bridge;
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  try {
    if (config.mode !== 'paired') {
      if (config.autoRegister !== true) throw new Error('标签通道尚未登记');
      config = await register(configFile, config, { log: report });
    }
    if (!TOKEN.test(String(config.agent || ''))) throw new Error('标签通道配对码无效');
    try {
      await apiCall(config.origin, config.agent, 'agent/poll', { ready: false });
    } catch (error) {
      if (error.status !== 401 || config.autoRegister !== true) throw new Error(`标签通道配对无效：${error.message}`);
      report('标签通道配对已失效，正在用送货单电脑身份重新登记');
      config = await register(configFile, { ...config, mode: 'unpaired' }, { log: report });
    }
    const { renderLabel } = require('./k3-render-cli.cjs');
    const outputDir = path.join(root, 'labels');
    fs.mkdirSync(outputDir, { recursive: true });
    const journal = createJournal(path.join(root, 'k3-jobs.json'));
    bridge = new SerialBridge({ port: config.port, baud: config.baud });
    const client = new K3Client(new BridgeTransport(bridge), { timeoutMs: 2500, printTimeoutMs: 90000 });

    const readyProbe = async () => {
      await client.connect();
      const model = await client.model();
      if (model.id !== 4864) throw new Error(`不是 K3（型号 ${model.id}）`);
      const beat = await client.heartbeat();
      if (beat.lidOpen) throw new Error('上盖未关闭');
      if (!beat.paperPresent) throw new Error('标签纸未装入');
      const status = await client.printStatus();
      return true;
    };
    const heartbeatFile = path.join(root, 'k3-heartbeat.json');
    const agent = createAgent({
      config, journal, client, render: renderLabel,
      call: (url, body) => apiCall(config.origin, config.agent, url, body),
      outputDir, log: report,
      readyProbe,
      onBeat: () => {
        try {
          fs.writeFileSync(heartbeatFile + '.tmp', JSON.stringify({
            pid: process.pid, at: Date.now(), progress: Date.now()
          }), { mode: 0o600 });
          fs.renameSync(heartbeatFile + '.tmp', heartbeatFile);
        } catch { /* missing beat only makes supervision cautious */ }
      }
    });
    while (!stopping) {
      await agent.tick();
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 1200));
    }
    agent.stop();
    journal.prune();
  } finally {
    if (bridge) await bridge.close();
    try { fs.unlinkSync(path.join(root, 'k3-heartbeat.json')); } catch { /* already gone */ }
    releaseLock();
  }
}

module.exports = {
  ORIGIN, signatureOf, createJournal, register, createAgent, checkConfig, validBitmap, apiCall
};

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`K3 标签接收程序启动失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
