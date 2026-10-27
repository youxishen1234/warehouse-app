const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { TextEncoder, TextDecoder } = require('node:util');

const root = process.cwd();
const compile = path => ts.transpileModule(fs.readFileSync(`${root}/${path}`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const id = 'remote-630k-client-0001';
const activeKey = 'warehouse_bluetooth_630k_active_job_v1';
const remotePendingKey = 'warehouse_remote_print_pending_v1';
const attemptKey = `warehouse_bluetooth_630k_attempt_v1:${id}`;
const relayId = '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f021';
const info = { v: 1, relayId, name: '630K', maxPayload: 524288, chunkSize: 180 };
const document = { key: 'delivery-1', number: 'SH-1', title: '送货单', party: '曙光', date: '2026-10-27', orderNumber: '', operator: '小李', lines: [] };
const settings = { template: 'delivery-note', formTitle: '出库单', paper: '241-93', width: 241, height: 93, company: '曙光', fontSize: 11, rowsPerPage: 5, offsetX: 0, offsetY: 0, showPrices: true, highClarity: true };
const input = (jobId = id) => ({ id: jobId, document, settings });
const queued = jobId => ({ v: 1, id: jobId, status: 'queued', message: '已进入队列', updatedAt: Date.now() });
const notFound = jobId => ({ v: 1, id: jobId, status: 'failed', code: 'JOB_NOT_FOUND', message: '原任务不存在', updatedAt: Date.now() });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };


function setup(options = {}) {
  const storage = new Map();
  const controls = [];
  const controlIds = [];
  const dataWrites = [];
  const statuses = new Map();
  const commandFrames = new Map();
  const statusWriteStarted = deferred();
  const statusReadStarted = deferred();
  let disconnect;
  let activeReads = 0;
  let requestCount = 0;
  const uuids = { service: '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f021', control: '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f022', info: '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f023', data: '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f024', status: '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f025' };
  const asView = value => { const bytes = new TextEncoder().encode(JSON.stringify(value)); return new DataView(bytes.buffer); };
  const ble = {
    initialize: async () => undefined,
    requestDevice: async () => { requestCount++; return { deviceId: 'device-1', name: '630K' }; },
    connect: async (_device, callback) => { disconnect = callback; },
    disconnect: async () => undefined,
    getDevices: async () => [{ deviceId: 'device-1', name: '630K' }],
    isBonded: async () => true,
    createBond: async () => undefined,
    getMtu: async () => 23,
    startNotifications: async () => undefined,
    stopNotifications: async () => undefined,
    read: async (_device, _service, characteristic) => {
      if (characteristic === uuids.info) return asView(info);
      if (characteristic !== uuids.status) throw new Error('unexpected read');
      activeReads++; statusReadStarted.resolve();
      const jobId = options.readJobId || Array.from(statuses.keys()).at(-1) || id;
      return asView(statuses.get(jobId) || notFound(jobId));
    },
    write: async (_device, _service, characteristic, view) => {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      if (characteristic === uuids.data) {
        if (options.disconnectOnData) { disconnect?.('device-1'); throw new Error('data disconnected'); }
        dataWrites.push(bytes.slice()); return;
      }
      if (characteristic !== uuids.control) throw new Error('unexpected write');
      const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const commandId = header.getUint16(1, false);
      const total = header.getUint16(3, false);
      const offset = header.getUint16(5, false);
      const length = header.getUint16(7, false);
      controlIds.push(commandId);
      const fragments = commandFrames.get(commandId) || new Map();
      fragments.set(offset, bytes.slice(9, 9 + length)); commandFrames.set(commandId, fragments);
      const commandBytes = new Uint8Array(total);
      let copied = 0;
      for (const [at, fragment] of fragments) { commandBytes.set(fragment, at); copied += fragment.length; }
      if (copied !== total) return;
      const command = JSON.parse(new TextDecoder().decode(commandBytes));
      controls.push(command);
      if (command.op === 'status') {
        statusWriteStarted.resolve();
        if (options.waitStatusWrite) await options.waitStatusWrite.promise;
      }
      if (command.op === 'commit') {
        if (storage.get(activeKey)?.id !== command.id) throw new Error('active ID missing at commit');
        if (options.disconnectOnCommit) { statuses.set(command.id, options.disconnectStatus || queued(command.id)); disconnect?.('device-1'); throw new Error('disconnected'); }
        statuses.set(command.id, options.commitStatus || queued(command.id));
      }
      if (command.op === 'resolve') {
        const old = statuses.get(command.id) || { v: 1, id: command.id, status: 'uncertain', message: '', updatedAt: Date.now() };
        statuses.set(command.id, { ...old, status: command.outcome === 'printed' ? 'queued' : 'failed', updatedAt: Date.now(), ...(command.outcome === 'printed' ? { confirmedPrintedAt: Date.now() } : {}) });
      }
    }
  };
  const taro = { default: {
    getStorageSync: key => {
      if (options.unreadableKeys?.has(key)) throw new Error('storage unavailable');
      return options.failReadback && key === activeKey && storage.has(key) ? undefined : storage.get(key);
    },
    setStorageSync: (key, value) => { if (options.failActiveWrite && key === activeKey) throw new Error('unavailable'); storage.set(key, value); },
    removeStorageSync: key => storage.delete(key)
  } };
  const load = (path, exports, require, globals = {}) => vm.runInNewContext(compile(path), { exports, require, TextEncoder, TextDecoder, Uint8Array, DataView, ArrayBuffer, Date, Math, Promise, setTimeout, clearTimeout, ...globals }, { filename: path });
  const pending = {};
  load('src/services/print-transport-pending.ts', pending, name => { assert.equal(name, '@tarojs/taro'); return taro; });
  const protocol = {};
  load('src/services/bluetooth-630k-protocol.ts', protocol, () => { throw new Error('protocol has no runtime import'); });
  const api = {};
  load('src/services/bluetooth-630k.ts', api, name => {
    if (name === '@tarojs/taro') return taro;
    if (name === '@capacitor/core') return { Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true, getPlatform: () => 'ios' } };
    if (name === '@capacitor-community/bluetooth-le') return { BleClient: ble };
    if (name === './print-transport-pending') return pending;
    if (name === './bluetooth-630k-protocol') return protocol;
    throw new Error('unexpected import: ' + name);
  }, { crypto: globalThis.crypto });
  return { api, storage, controls, controlIds, dataWrites, statuses, activeReads: () => activeReads, waitStatusWrite: statusWriteStarted, waitStatusRead: statusReadStarted, requestCount: () => requestCount };
}
const connect = api => api.connectBluetooth630K(true);


test('active ID is durable before commit, queued state clears only the active gate, and write frames use command IDs', async () => {
  const h = setup(); await connect(h.api);
  const job = await h.api.sendBluetooth630KJob(input());
  assert.equal(job.status, 'queued');
  assert.equal(h.controls.some(command => command.op === 'commit'), true);
  assert.equal(h.storage.has(activeKey), false);
  assert.equal(h.api.readBluetooth630KJobAttempt(id).status, 'queued');
  assert.equal(h.api.readBluetooth630KJobAttempt(id).sha256.length, 64);
  assert.ok(h.dataWrites.length);
  const uniqueIds = [...new Set(h.controlIds)];
  assert.deepEqual(uniqueIds, uniqueIds.map((_, index) => index + 1));
});


test('failed active-ID write or readback prevents any begin, data, or commit', async () => {
  for (const options of [{ failActiveWrite: true }, { failReadback: true }]) {
    const h = setup(options); await connect(h.api);
    await assert.rejects(h.api.sendBluetooth630KJob(input()), /本机记录保存失败/);
    assert.equal(h.controls.some(command => command.op === 'begin' || command.op === 'commit'), false);
    assert.equal(h.dataWrites.length, 0);
  }
});

test('network pending blocks Bluetooth submission even when BLE is connected', async () => {
  const h = setup();
  h.storage.set(remotePendingKey, { id: 'remote-print-client-pending-0001', noteId: 17 });
  await connect(h.api);
  await assert.rejects(h.api.sendBluetooth630KJob(input()), /网络打印原任务尚未确认/);
  assert.equal(h.controls.some(command => ['begin', 'commit'].includes(command.op)), false);
  assert.equal(h.dataWrites.length, 0);
});

test('concurrent submission is deduplicated by ID and blocks different IDs', async () => {
  const gate = deferred();
  const h = setup({ waitStatusWrite: gate });
  await connect(h.api);
  const first = h.api.sendBluetooth630KJob(input());
  const duplicate = h.api.sendBluetooth630KJob(input());
  assert.strictEqual(duplicate, first);
  await assert.rejects(h.api.sendBluetooth630KJob(input('remote-630k-client-0002')), /已有蓝牙打印任务正在发送/);
  gate.resolve(); await first;
  assert.equal(h.controls.filter(command => command.op === 'commit').length, 1);
});

test('another active Bluetooth ID blocks cross-ID send and selecting a different device', async () => {
  const activeId = 'remote-630k-client-0002';
  const h = setup();
  h.storage.set(activeKey, { id: activeId, deviceId: 'device-1', relayId });
  h.statuses.set(activeId, notFound(activeId));
  await assert.rejects(h.api.connectBluetooth630K(true), /存在未确认的原蓝牙打印任务/);
  assert.equal(h.requestCount(), 0, 'a different device must not be requested while a task is active');
  await h.api.connectBluetooth630K(false);
  await assert.rejects(h.api.sendBluetooth630KJob(input()), /原蓝牙打印任务仍未终结/);
  assert.equal(h.controls.some(command => ['begin', 'commit'].includes(command.op)), false);
  assert.equal(h.dataWrites.length, 0);
});

test('disconnect after received keeps ID gated; reconnect queries the same ID and never resends', async () => {
  const received = { v: 1, id, status: 'received', message: '已接收', updatedAt: Date.now() };
  const h = setup({ disconnectStatus: received, disconnectOnCommit: true });
  await connect(h.api);
  const job = await h.api.sendBluetooth630KJob(input());
  assert.equal(job.status, 'uncertain');
  assert.equal(h.storage.get(activeKey).id, id);
  assert.equal(h.api.readBluetooth630KJobAttempt(id).status, 'uncertain');
  assert.equal(h.controls.filter(command => command.op === 'commit').length, 1);
  await assert.rejects(h.api.connectBluetooth630K(true), /不能切换设备/);
  await assert.rejects(h.api.disconnectBluetooth630K(true), /不能忘记设备/);
  await h.api.connectBluetooth630K(false);
  assert.equal(h.controls.filter(command => command.op === 'commit').length, 1);
  assert.equal(h.controls.some(command => command.op === 'status' && command.id === id), true);
  assert.equal(h.storage.get(activeKey).id, id, 'received remains active');
  assert.equal(h.api.readBluetooth630KJobAttempt(id).status, 'received');
});

test('corrupt or unreadable local pending storage fails closed before Bluetooth transfer', async () => {
  for (const mode of ['corrupt', 'unreadable']) {
    const unreadableKeys = new Set();
    const h = setup({ unreadableKeys });
    await connect(h.api);
    if (mode === 'corrupt') h.storage.set(activeKey, { id: 'invalid-id', deviceId: 'device-1', relayId });
    else unreadableKeys.add(activeKey);
    await assert.rejects(h.api.sendBluetooth630KJob(input()), mode === 'corrupt' ? /无法识别的原打印记录/ : /打印记录读取失败/);
    assert.equal(h.controls.some(command => ['begin', 'commit'].includes(command.op)), false, `${mode}: no begin or commit`);
    assert.equal(h.dataWrites.length, 0, `${mode}: no payload data`);
  }
});

test('a committed uncertain ID cannot be retransferred after a stale JOB_NOT_FOUND response', async () => {
  const uncertain = { v: 1, id, status: 'uncertain', message: '结果不确定', updatedAt: Date.now() };
  const h = setup({ disconnectStatus: uncertain, disconnectOnCommit: true }); await connect(h.api);
  await h.api.sendBluetooth630KJob(input());
  await h.api.connectBluetooth630K(false);
  h.statuses.set(id, notFound(id));
  await assert.rejects(h.api.sendBluetooth630KJob(input()), /不会自动重发/);
  assert.equal(h.controls.filter(command => command.op === 'commit').length, 1);
});

test('a pre-commit interruption releases its gate only after the host confirms no task exists', async () => {
  const h = setup({ disconnectOnData: true }); await connect(h.api);
  const job = await h.api.sendBluetooth630KJob(input());
  assert.equal(job.status, 'uncertain');
  assert.equal(h.api.readBluetooth630KJobAttempt(id).commitStarted, false);
  assert.equal(h.storage.get(activeKey).id, id);
  assert.equal(h.controls.some(command => command.op === 'commit'), false);
  await h.api.connectBluetooth630K(false);
  assert.equal(h.api.getBluetooth630KState().job.status, 'failed');
  assert.equal(h.storage.has(activeKey), false);
  assert.equal(h.controls.some(command => command.op === 'commit'), false);
});

test('a legacy active attempt without commit metadata remains gated after a host 404', async () => {
  const h = setup(); await connect(h.api);
  h.storage.set(activeKey, { id, deviceId: 'device-1', relayId });
  h.storage.set(attemptKey, { id, status: 'uncertain', updatedAt: Date.now(), deviceId: 'device-1', relayId });
  await assert.rejects(h.api.queryBluetooth630KJob(id), /没有任务/);
  assert.equal(h.storage.get(activeKey).id, id);
  assert.equal(h.controls.some(command => command.op === 'commit'), false);
});


test('queued+printed is optional confirmation; queued+missing cannot resolve or retransmit', async () => {
  const h = setup(); await connect(h.api); await h.api.sendBluetooth630KJob(input());
  await assert.rejects(h.api.resolveBluetooth630KJob(id, 'missing'), /不能按未打印重新发送/);
  assert.equal(h.controls.some(command => command.op === 'resolve' && command.outcome === 'missing'), false);
  const confirmed = await h.api.resolveBluetooth630KJob(id, 'printed');
  assert.equal(confirmed.status, 'queued');
  assert.ok(Number.isSafeInteger(confirmed.confirmedPrintedAt));
  assert.equal(h.controls.some(command => command.op === 'resolve' && command.outcome === 'printed'), true);
});


test('status read occurs only after the control write, which awaits host HTTP completion', async () => {
  const gate = deferred();
  const h = setup({ waitStatusWrite: gate }); await connect(h.api);
  h.statuses.set(id, queued(id));
  const query = h.api.queryBluetooth630KJob(id);
  await h.waitStatusWrite.promise;
  assert.equal(h.activeReads(), 0);
  h.statuses.set(id, queued(id));
  gate.resolve();
  const job = await query;
  assert.equal(job.status, 'queued');
  assert.equal(h.activeReads(), 1);
});
