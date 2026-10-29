const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('src/services/remote-print.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const token = 'a'.repeat(64);
const pendingKey = 'warehouse_remote_print_pending_v1';
const response = data => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
const rejectedResponse = (status, message) => ({ ok: false, status, json: async () => ({ success: false, message }) });
function setup(fetch, storageOptions = {}) {
  const storage = new Map([['warehouse_remote_print_pair_v1', token]]);
  const api = {};
  const timers = [];
  const taro = { default: {
    getStorageSync: key => { if (storageOptions.failRead) throw new Error('storage unavailable'); return storage.get(key); },
    setStorageSync: (key, value) => { if (storageOptions.failWrite) throw new Error('storage unavailable'); storage.set(key, value); },
    removeStorageSync: key => { if (storageOptions.failRemove) throw new Error('storage unavailable'); storage.delete(key); }
  } };
  const pending = {};
  const pendingCode = ts.transpileModule(fs.readFileSync('src/services/print-transport-pending.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(pendingCode, { exports: pending, require: id => { assert.equal(id, '@tarojs/taro'); return taro; } });
  vm.runInNewContext(code, {
    exports: api, fetch, AbortController, crypto: {}, Date, Math,
    URL, URLSearchParams,
    setTimeout: (fn, ms) => { timers.push(ms); return setTimeout(fn, 25); }, clearTimeout,
    require: id => {
      if (id === './request') return { getBaseUrl: () => 'https://print.example.test' };
      if (id === '@tarojs/taro') return taro;
      if (id === './print-transport-pending') return pending;
      throw new Error('Printing must not depend on the warehouse session: ' + id);
    }
  });
  return { api, storage, timers };
}
test('pending network work blocks another task and changing the paired computer', async () => {
  const calls = [];
  const { api, storage } = setup(async (_, options) => { calls.push(options); return response({ id: 'remote-task-0000001', status: 'waiting' }); });
  await api.submitRemotePrint({ id: 'remote-task-0000001', note_id: 1, version: 1, paper: '241-93' });
  assert.equal(api.readRemotePrintPending().id, 'remote-task-0000001');
  await assert.rejects(api.submitRemotePrint({ id: 'remote-task-0000002', note_id: 2, version: 1, paper: '241-93' }), /原任务尚未确认/);
  assert.throws(() => api.savePrintPair('b'.repeat(64)), /原任务尚未确认/);
  assert.equal(calls.length, 1);
  assert.equal(storage.get('warehouse_remote_print_pair_v1'), token);
});
test('first submit clears pending only for explicit pre-enqueue 400/401 rejections', async () => {
  const job = { id: 'remote-task-0000001', note_id: 1, version: 1, paper: '241-93' };
  for (const [status, message] of [[400, '请先保存送货单'], [401, '打印配对已失效，请重新配对']]) {
    let storage;
    const h = setup(async () => {
      assert.equal(storage.get(pendingKey)?.id, job.id, 'pending is persisted before the HTTP request');
      return rejectedResponse(status, message);
    });
    storage = h.storage;
    await assert.rejects(h.api.submitRemotePrint(job), error => error.statusCode === status);
    assert.equal(storage.has(pendingKey), false, `${status} proves the first request was rejected before enqueue`);
  }
});
test('404/409, network ambiguity, query not-found, and existing retries keep pending', async () => {
  const job = { id: 'remote-task-0000001', note_id: 1, version: 1, paper: '241-93' };
  for (const status of [404, 409, 500]) {
    const h = setup(async () => rejectedResponse(status, 'ambiguous rejection'));
    await assert.rejects(h.api.submitRemotePrint(job), error => error.statusCode === status);
    assert.equal(h.storage.has(pendingKey), true, `${status} is not a definitive first-submit rejection`);
  }
  const query = setup(async () => rejectedResponse(404, '打印任务不存在'));
  query.storage.set(pendingKey, { id: job.id, noteId: job.note_id });
  await assert.rejects(query.api.getRemotePrintJob(job.id), error => error.statusCode === 404);
  assert.equal(query.storage.has(pendingKey), true, 'query not-found never releases the gate');

  let calls = 0;
  const retry = setup(async () => ++calls === 1
    ? response({ id: job.id, status: 'waiting' })
    : rejectedResponse(400, '请先保存送货单'));
  await retry.api.submitRemotePrint(job);
  await assert.rejects(retry.api.submitRemotePrint(job), error => error.statusCode === 400);
  assert.equal(retry.storage.has(pendingKey), true, 'a request using an existing pending ID remains conservative');

  let disconnectCalls = 0;
  const disconnected = setup(async () => {
    if (++disconnectCalls === 1) throw new TypeError('Failed to fetch');
    return rejectedResponse(400, '请先保存送货单');
  });
  await assert.rejects(disconnected.api.submitRemotePrint(job), /网络中断/);
  assert.equal(disconnected.storage.has(pendingKey), true);
  await assert.rejects(disconnected.api.submitRemotePrint(job), error => error.statusCode === 400);
  assert.equal(disconnected.storage.has(pendingKey), true, 'a rejection after an unknown earlier submit stays gated');
  const timedOut = setup(() => new Promise(() => {}));
  await assert.rejects(timedOut.api.submitRemotePrint(job), /发送结果尚未确认/);
  assert.equal(timedOut.storage.has(pendingKey), true);
});
test('a concurrent same-ID retry prevents clearing after the first request is rejected', async () => {
  const job = { id: 'remote-task-0000001', note_id: 1, version: 1, paper: '241-93' };
  let resolveFirst;
  let startFirst;
  const firstResponse = new Promise(resolve => { resolveFirst = resolve; });
  const firstStarted = new Promise(resolve => { startFirst = resolve; });
  let calls = 0;
  const h = setup(async () => {
    calls++;
    if (calls === 1) { startFirst(); return firstResponse; }
    return response({ id: job.id, status: 'waiting' });
  });
  const first = h.api.submitRemotePrint(job);
  await firstStarted;
  await h.api.submitRemotePrint(job);
  resolveFirst(rejectedResponse(400, '请先保存送货单'));
  await assert.rejects(first, error => error.statusCode === 400);
  assert.equal(h.storage.has(pendingKey), true, 'another same-ID request may have crossed the enqueue boundary');
});
test('BLE pending work blocks HTTPS before creating a network task', async () => {
  let calls = 0;
  const { api, storage } = setup(async () => { calls++; return response({}); });
  for (const value of ['ble-active-job-00001', { id: 'ble-active-job-00001', deviceId: 'radio-1' }]) {
    storage.set('warehouse_bluetooth_630k_active_job_v1', value);
    await assert.rejects(api.submitRemotePrint({ id: 'remote-task-0000001', note_id: 1, version: 1, paper: '241-93' }), /蓝牙原任务尚未确认/);
  }
  assert.equal(calls, 0);
  assert.equal(storage.has('warehouse_remote_print_pending_v1'), false);
});
test('only terminal receipts for the same ID release the network pending gate', async () => {
  let receipt = { id: 'remote-task-0000001', status: 'waiting' };
  const { api, storage } = setup(async () => response(receipt));
  await api.submitRemotePrint({ id: receipt.id, note_id: 1, version: 1, paper: '241-93' });
  receipt = { id: 'remote-task-0000002', status: 'queued' };
  await api.getRemotePrintJob(receipt.id);
  assert.equal(api.readRemotePrintPending().id, 'remote-task-0000001');
  receipt = { id: 'remote-task-0000001', status: 'uncertain' };
  await api.getRemotePrintJob(receipt.id);
  assert.equal(api.readRemotePrintPending().id, receipt.id);
  receipt = { ...receipt, status: 'queued' };
  await api.resolveRemotePrintJob(receipt.id, 'printed');
  assert.equal(storage.has('warehouse_remote_print_pending_v1'), false);
});
test('terminal status remains queryable when clearing local storage fails', async () => {
  const { api, storage } = setup(async () => response({ id: 'remote-task-0000001', status: 'queued' }), { failRemove: true });
  storage.set('warehouse_remote_print_pending_v1', { id: 'remote-task-0000001', noteId: 1 });
  const result = await api.getRemotePrintJob('remote-task-0000001');
  assert.equal(result.status, 'queued');
  assert.equal(api.readRemotePrintPending().id, result.id, 'a failed clear keeps the conservative pending gate');
});
test('unreadable or unwritable persistence prevents any network submission', async () => {
  for (const storageOptions of [{ failRead: true }, { failWrite: true }]) {
    let calls = 0;
    const { api } = setup(async () => { calls++; return response({}); }, storageOptions);
    await assert.rejects(api.submitRemotePrint({ id: 'remote-task-0000001', note_id: 1, version: 1, paper: '241-93' }, token));
    assert.equal(calls, 0);
  }
});
test('remote submission goes directly to the paired print API and preserves the task ID on retries', async () => {
  const calls = [];
  const { api } = setup(async (url, options) => { calls.push({ url, options }); return response({ id: 'remote-task-0000001', status: 'waiting' }); });
  const job = { id: 'remote-task-0000001', note_id: 1, version: 1, paper: '241-93' };
  await api.submitRemotePrint(job); await api.submitRemotePrint(job);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://print.example.test/api/remote-print/jobs');
    assert.equal(call.options.headers['X-Print-Client'], token);
    assert.deepEqual(JSON.parse(call.options.body), job);
    assert.equal(call.options.headers.Authorization, undefined);
  }
});
test('both a stalled connection and a stalled JSON body have a hard eight-second deadline', async () => {
  for (const fetch of [() => new Promise(() => {}), async () => ({ ok: true, json: () => new Promise(() => {}) })]) {
    const { api, timers } = setup(fetch);
    await assert.rejects(api.getRemoteDevice(), /查询超时/);
    assert.deepEqual(timers, [8000]);
  }
});
test('pairing validation uses the candidate token without storing invalid pairing or logging out', async () => {
  const candidate = 'b'.repeat(64);
  const { api, storage } = setup(async (_, options) => {
    assert.equal(options.headers['X-Print-Client'], candidate);
    return { ok: false, status: 401, json: async () => ({ success: false, message: '打印配对已失效，请重新配对' }) };
  });
  await assert.rejects(api.getRemoteDevice(candidate), error => error.statusCode === 401 && /配对/.test(error.message));
  assert.equal(storage.get('warehouse_remote_print_pair_v1'), token);
});
test('connection links and raw QR payloads resolve the pairing token and can be cleaned', () => {
  const { api } = setup(() => { throw new Error('unused'); });
  const link = 'https://youxishen.online/#/pages/management/index?section=labels&print_pair=' + token + '&kind=finished-product';
  assert.equal(api.parsePrintPairToken(token), token);
  assert.equal(api.parsePrintPairToken(link), token);
  assert.equal(api.parsePrintPairToken('https://youxishen.online/?print_pair=bad'), '');
  assert.equal(
    api.cleanPrintPairUrl(link),
    'https://youxishen.online/#/pages/management/index?section=labels&kind=finished-product'
  );
  assert.equal(
    api.cleanPrintPairUrl('https://youxishen.online/?print_pair=' + token + '&tab=stock'),
    'https://youxishen.online/?tab=stock'
  );
});
test('old WebViews can create distinct valid print IDs without crypto.randomUUID', () => {
  const { api } = setup(() => { throw new Error('unused'); });
  const ids = Array.from({ length: 100 }, () => api.newRemotePrintId());
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach(id => assert.match(id, /^[a-zA-Z0-9-]{16,100}$/));
});
