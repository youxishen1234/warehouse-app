const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('src/services/remote-print.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const token = 'a'.repeat(64);
const response = data => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
function setup(fetch) {
  const storage = new Map([['warehouse_remote_print_pair_v1', token]]);
  const api = {};
  const timers = [];
  vm.runInNewContext(code, {
    exports: api, fetch, AbortController, crypto: {}, Date, Math,
    URL, URLSearchParams,
    setTimeout: (fn, ms) => { timers.push(ms); return setTimeout(fn, 25); }, clearTimeout,
    require: id => {
      if (id === './request') return { getBaseUrl: () => 'https://print.example.test' };
      if (id === '@tarojs/taro') return { default: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value) } };
      throw new Error('Printing must not depend on the warehouse session: ' + id);
    }
  });
  return { api, storage, timers };
}
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
  const link = 'https://youxishen.online/#/pages/label-print/index?print_pair=' + token + '&kind=finished-product';
  assert.equal(api.parsePrintPairToken(token), token);
  assert.equal(api.parsePrintPairToken(link), token);
  assert.equal(api.parsePrintPairToken('https://youxishen.online/?print_pair=bad'), '');
  assert.equal(
    api.cleanPrintPairUrl(link),
    'https://youxishen.online/#/pages/label-print/index?kind=finished-product'
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
