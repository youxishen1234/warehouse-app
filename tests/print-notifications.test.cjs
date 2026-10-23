const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync('src/services/print-notifications.ts', 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const storageKey = 'warehouse_print_notices_v1';
const pairKey = 'warehouse_remote_print_pair_v1';
const tokenA = 'a'.repeat(64);
const tokenB = 'b'.repeat(64);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createEvents() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    dispatch(name) {
      for (const listener of [...(listeners.get(name) || [])]) listener();
    }
  };
}

function setup(options = {}) {
  const storage = options.storage || new Map();
  if (options.token !== undefined) storage.set(pairKey, options.token);
  else if (!storage.has(pairKey)) storage.set(pairKey, tokenA);
  const calls = [];
  const timers = new Map();
  const document = Object.assign(createEvents(), { hidden: false });
  const window = createEvents();
  let now = options.now ?? 1_800_000_000_000;
  let nextTimerId = 1;
  let failWrites = false;
  const taro = {
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) {
      if (failWrites) throw new Error('storage full');
      storage.set(key, value);
    },
    removeStorageSync(key) { storage.delete(key); }
  };
  const remote = {
    readPrintPair() { return storage.get(pairKey) || ''; },
    resolveRemotePrintJob: options.resolveJob || (async (id, outcome, token) => ({
      id, status: outcome === 'printed' ? 'queued' : 'failed', message: '已人工核对', token
    })),
    getRemoteDevice: options.getDevice || (async token => {
      calls.push({ method: 'GET', kind: 'device', token });
      return { id: 'device-1', name: '测试打印电脑', printer: '630K', online: true, ready: true };
    }),
    getRemotePrintJob: options.getJob || (async (id, token) => {
      calls.push({ method: 'GET', kind: 'job', id, token });
      return { id, status: 'waiting', message: '等待打印电脑接收' };
    })
  };
  class FakeDate extends Date {
    static now() { return now; }
  }
  const api = {};
  vm.runInNewContext(code, {
    exports: api,
    Date: FakeDate,
    document,
    window,
    setInterval(callback, ms) {
      const id = nextTimerId++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    require(id) {
      if (id === '@tarojs/taro') return { default: taro };
      if (id === './remote-print') return remote;
      if (id === 'react') return { useEffect() {}, useState(value) { return [value, () => {}]; } };
      throw new Error('Unexpected dependency: ' + id);
    }
  });
  return {
    api, storage, calls, timers, document, window,
    setNow(value) { now = value; },
    setFailWrites(value) { failWrites = value; }
  };
}

const record = (id, overrides = {}) => ({
  id,
  noteId: Number(id.replace(/\D/g, '')) || 1,
  noteNumber: 'XS-' + id,
  printer: '630K',
  deviceId: 'device-1',
  createdAt: 1_800_000_000_000,
  ...overrides
});
const job = (id, status, message = '状态消息', overrides = {}) => ({
  id, status, message, ...overrides
});

test('persists a task before submission, deduplicates by id, and preserves observed status/error/time', () => {
  const { api, storage, setFailWrites } = setup();
  api.trackPrintNotice(record('task-1'));
  assert.equal(storage.get(storageKey).records[0].id, 'task-1');
  api.updatePrintNotice(job('task-1', 'processing'));
  api.reportPrintNoticeError('task-1', '查询超时');
  api.trackPrintNotice(record('task-1', {
    noteNumber: '重试登记', createdAt: 1_900_000_000_000
  }));

  let notices = api.readPrintNotices().records;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].createdAt, 1_800_000_000_000);
  assert.equal(notices[0].noteNumber, '重试登记');
  assert.equal(notices[0].job.status, 'processing');
  assert.equal(notices[0].error, '查询超时');

  setFailWrites(true);
  api.trackPrintNotice(record('task-2'));
  notices = api.readPrintNotices().records;
  assert.equal(notices.length, 2, 'a quota error must not drop an in-memory task');
  assert.equal(notices[0].id, 'task-2');
});

test('loads only the matching pairing scope and keeps pending notices while pruning old terminals', () => {
  const first = setup();
  first.api.trackPrintNotice(record('task-1', { job: job('task-1', 'queued') }));
  const serialized = JSON.stringify(first.storage.get(storageKey));
  assert.equal(serialized.includes(tokenA), false, 'raw pairing tokens must not be persisted');

  const otherPair = setup({ storage: first.storage, token: tokenB });
  assert.equal(otherPair.api.readPrintNotices().records.length, 0);
  assert.equal(otherPair.storage.has(storageKey), false, 'mismatched-scope persisted records are removed');

  const { api, setNow } = setup();
  const old = 1_800_000_000_000 - 8 * 24 * 60 * 60 * 1000;
  setNow(1_800_000_000_000);
  api.trackPrintNotice(record('old-terminal', { createdAt: old, job: job('old-terminal', 'queued') }));
  api.trackPrintNotice(record('old-pending', { createdAt: old }));
  assert.equal(Array.from(api.readPrintNotices().records, item => item.id).join(','), 'old-pending');

  for (let index = 0; index < 22; index++) {
    api.trackPrintNotice(record('terminal-' + index, { job: job('terminal-' + index, 'failed') }));
  }
  const remaining = api.readPrintNotices().records;
  assert.ok(remaining.some(item => item.id === 'old-pending'), 'pending work is never evicted by the terminal cap');
  assert.ok(remaining.length <= 20);
});

test('refresh polls at most ten pending IDs using GET and coalesces concurrent refreshes', async () => {
  const device = deferred();
  const statuses = new Map();
  const { api, calls } = setup({
    getDevice: token => { calls.push({ method: 'GET', kind: 'device', token }); return device.promise; },
    getJob: (id, token) => {
      calls.push({ method: 'GET', kind: 'job', id, token });
      const pending = deferred();
      statuses.set(id, pending);
      return pending.promise;
    }
  });
  for (let index = 0; index < 12; index++) api.trackPrintNotice(record('task-' + index, { createdAt: 1_800_000_000_000 + index }));

  const first = api.refreshPrintNotices();
  const second = api.refreshPrintNotices();
  assert.equal(first, second);
  assert.equal(calls.filter(call => call.kind === 'job').length, 10);
  assert.ok(calls.every(call => call.method === 'GET'));
  device.resolve({ id: 'device-1', name: '测试打印电脑', printer: '630K', online: true, ready: true });
  for (const [id, pending] of statuses) pending.resolve(job(id, 'queued', '已送入630K打印队列，请以实际出纸为准'));
  await first;
  assert.equal(api.readPrintNotices().records.filter(item => item.job?.status === 'queued').length, 10);
});

test('pair changes clear persisted work immediately and stale GET responses cannot restore it', async () => {
  const device = deferred();
  const jobResponse = deferred();
  const { api, storage, calls } = setup({
    getDevice: token => { calls.push({ method: 'GET', kind: 'device', token }); return device.promise; },
    getJob: (id, token) => { calls.push({ method: 'GET', kind: 'job', id, token }); return jobResponse.promise; }
  });
  api.trackPrintNotice(record('task-stale'));
  const refresh = api.refreshPrintNotices();
  assert.ok(calls.some(call => call.kind === 'device' && call.token === tokenA));
  assert.ok(calls.some(call => call.kind === 'job' && call.token === tokenA));

  storage.set(pairKey, tokenB);
  device.resolve({ id: 'device-1', name: '新打印电脑', printer: '630K', online: true, ready: true });
  jobResponse.resolve(job('task-stale', 'queued', '旧配对任务'));
  await refresh;

  assert.equal(api.readPrintNotices().records.length, 0);
  assert.equal(storage.get(storageKey).records.length, 0);
  assert.equal(JSON.stringify(storage.get(storageKey)).includes(tokenA), false);
});

test('dismiss hides a notice while the original task keeps polling, then a new status reopens it', async () => {
  let status = 'waiting';
  const { api, storage, calls } = setup({
    getJob: async (id, token) => {
      calls.push({ method: 'GET', kind: 'job', id, token });
      return job(id, status);
    }
  });
  api.trackPrintNotice(record('task-dismiss'));
  api.dismissPrintNotice('task-dismiss');
  assert.equal(api.readPrintNotices().records[0].dismissed, true);
  await api.refreshPrintNotices();
  assert.equal(calls.filter(call => call.kind === 'job').length, 1, 'closing a banner must not stop observing the original task');
  assert.equal(calls.some(call => call.method !== 'GET'), false);
  assert.equal(api.readPrintNotices().records.length, 1);
  assert.equal(api.readPrintNotices().records[0].dismissed, true, 'the same phase must not reopen a closed banner');
  assert.equal(storage.get(storageKey).records[0].id, 'task-dismiss');

  status = 'processing';
  await api.refreshPrintNotices();
  assert.equal(api.readPrintNotices().records[0].job.status, 'processing');
  assert.equal(api.readPrintNotices().records[0].dismissed, false, 'a real status change must reach the operator again');
  assert.equal(calls.filter(call => call.kind === 'job').length, 2);
  assert.equal(calls.some(call => call.method !== 'GET'), false);
});

test('monitor has one reference-counted foreground timer and reacts to visibility, online, and focus', async () => {
  const { api, timers, document, window, calls } = setup();
  const stopA = api.startPrintNoticeMonitor();
  const stopB = api.startPrintNoticeMonitor();
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 5000);
  assert.equal(document.listeners.get('visibilitychange').size, 1);
  assert.equal(window.listeners.get('online').size, 1);
  assert.equal(window.listeners.get('focus').size, 1);
  await Promise.resolve();
  await Promise.resolve();

  document.hidden = true;
  document.dispatch('visibilitychange');
  assert.equal(timers.size, 0);
  const deviceCallsWhileHidden = calls.filter(call => call.kind === 'device').length;
  window.dispatch('online');
  window.dispatch('focus');
  assert.equal(calls.filter(call => call.kind === 'device').length, deviceCallsWhileHidden);

  document.hidden = false;
  document.dispatch('visibilitychange');
  assert.equal(timers.size, 1);
  stopA();
  stopA();
  assert.equal(timers.size, 1, 'one owner cannot stop the other owner’s monitor');
  stopB();
  assert.equal(timers.size, 0);
  assert.equal(document.listeners.get('visibilitychange').size, 0);
  assert.equal(window.listeners.get('online').size, 0);
});

test('descriptions distinguish pending, offline, unavailable, stalled, uncertain, queued, failed, expired, and unknown', () => {
  const { api } = setup();
  const describe = (notice, snapshot = {}) => api.describePrintNotice(notice, {
    records: [], deviceError: '', now: 1_800_000_000_000, checking: false, ...snapshot
  });

  assert.equal(describe(record('wait', { job: job('wait', 'waiting') }), {
    device: { id: 'device-1', name: 'P', printer: '630K', online: false, ready: false }
  }).title, '等待打印电脑上线');
  assert.equal(describe(record('wait', { job: job('wait', 'waiting') }), {
    device: { id: 'device-1', name: 'P', printer: '630K', online: true, ready: false }
  }).title, '打印机暂不可用');
  assert.equal(describe(record('process', { job: job('process', 'processing', '打印中', { updated_at: 1_800_000_000_000 - 60_001 }) })).tone, 'warning');

  const uncertain = describe(record('maybe', { job: job('maybe', 'uncertain') }), { deviceError: '离线' });
  assert.equal(uncertain.tone, 'danger');
  assert.match(uncertain.message, /人工核对/);
  assert.match(uncertain.message, /离线/);

  const queued = describe(record('queued', { job: job('queued', 'queued', '已送入630K打印队列，请以实际出纸为准') }));
  assert.equal(queued.title, '已送入打印队列');
  assert.equal(queued.tone, 'info');
  assert.match(queued.message, /不代表纸张已实际打印出来/);
  assert.equal(describe(record('verified', { job: job('verified', 'queued', '已人工确认实际出纸') })).tone, 'success');

  assert.equal(describe(record('failed', { job: job('failed', 'failed', '打印机错误') })).tone, 'danger');
  assert.equal(describe(record('expired', { job: job('expired', 'expired') })).tone, 'warning');
  const unknown = describe(record('unknown', { job: job('unknown', 'processing'), error: '查询超时' }));
  assert.equal(unknown.title, '打印状态暂未确认');
  assert.match(unknown.message, /不会自动重复发送/);
});

test('device and task query failures preserve the prior job and subscriber snapshots remain stable', async () => {
  const { api } = setup({
    getDevice: async () => { throw new Error('打印电脑连接失败'); },
    getJob: async () => { throw new Error('状态查询失败'); }
  });
  let notifications = 0;
  const unsubscribe = api.watchPrintNotices(() => { notifications++; });
  const initial = api.readPrintNotices();
  assert.equal(api.readPrintNotices(), initial);
  api.trackPrintNotice(record('task-preserve'));
  api.updatePrintNotice(job('task-preserve', 'processing'));
  await api.refreshPrintNotices();
  const latest = api.readPrintNotices();
  assert.equal(latest.records[0].job.status, 'processing', 'a failed GET must retain the last known job');
  assert.equal(latest.records[0].error, '状态查询失败');
  assert.equal(latest.deviceError, '打印电脑连接失败');
  assert.ok(notifications >= 3);
  unsubscribe();
  const afterUnsubscribe = notifications;
  api.dismissPrintNotice('task-preserve');
  assert.equal(notifications, afterUnsubscribe);
});

test('closing a failure banner does not hide the same transient query failure again and again', async () => {
  const { api } = setup({
    getDevice: async () => ({ id: 'device-1', name: '测试打印电脑', printer: '630K', online: true, ready: true }),
    getJob: async () => { throw new Error('状态查询超时'); }
  });
  api.trackPrintNotice(record('task-flaky'));
  await api.refreshPrintNotices();
  assert.equal(api.readPrintNotices().records[0].error, '状态查询超时');
  api.dismissPrintNotice('task-flaky');
  assert.equal(api.readPrintNotices().records[0].dismissed, true);
  await api.refreshPrintNotices();
  assert.equal(api.readPrintNotices().records[0].dismissed, true, 'the same failed GET must not reopen the banner');

  api.updatePrintNotice(job('task-flaky', 'queued', '已送入打印队列'));
  assert.equal(api.readPrintNotices().records[0].dismissed, false, 'a successfully observed status is a real change');
  assert.equal(api.readPrintNotices().records[0].error, undefined);
});

test('an uncertain job keeps being observed but is not evicted as an old terminal', async () => {
  let status = 'uncertain';
  let updatedAt = 1_800_000_000_000;
  const { api, setNow, calls } = setup({
    getJob: async (id, token) => {
      calls.push({ method: 'GET', kind: 'job', id, token });
      return job(id, status, '状态消息', { updated_at: updatedAt });
    }
  });
  api.trackPrintNotice(record('task-manual'));
  api.updatePrintNotice(job('task-manual', 'uncertain'));
  await api.refreshPrintNotices();
  assert.equal(calls.filter(call => call.kind === 'job').length, 1, 'a person still needs the updated status');
  updatedAt = 1_800_000_000_000 + 8 * 24 * 60 * 60 * 1000;
  setNow(updatedAt);
  status = 'queued';
  await api.refreshPrintNotices();
  assert.equal(api.readPrintNotices().records.length, 1);
  assert.equal(api.readPrintNotices().records[0].job.status, 'queued');
});
