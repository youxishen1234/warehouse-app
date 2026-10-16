const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const response = data => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Warehouse-Revision': '1' } });
function setup(fetch) {
  const storage = new Map();
  const taro = { getStorageSync: k => storage.get(k), setStorageSync: (k,v) => storage.set(k,v), removeStorageSync: k => storage.delete(k), showToast: () => {} };
  const modules = { '@tarojs/taro': { default: taro }, './session': { PUBLIC_ORIGIN: 'https://youxishen.online', TEAM_ORIGIN: 'https://youxishen.online', sessionOrigin: () => 'https://youxishen.online', session: () => ({ token: 'test-only', user: { id: 'fixture' } }), watchSession: () => {}, deviceId: () => 'recheck-test' }, './shared-refresh': { refreshSharedData: () => {} } };
  const output = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync('src/services/request.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports: output.exports, module: output, require: id => { assert.ok(id in modules); return modules[id]; }, fetch, AbortController, URL, setTimeout, clearTimeout, process: { env: { NODE_ENV: 'production' } }, console });
  return output.exports;
}
test('print-time forced GET does not reuse or clear an older in-flight read', async () => {
  const waiting = [];
  const api = setup((url, options) => { assert.equal(options.cache, 'no-store'); return new Promise(resolve => waiting.push(resolve)); });
  const first = api.request({ url: '/api/products/1' });
  assert.equal(api.request({ url: '/api/products/1' }), first);
  const fresh = api.request({ url: '/api/products/1', forceNetwork: true });
  assert.notEqual(first, fresh);
  assert.equal(waiting.length, 2);
  waiting[1](response({ stock: 9 }));
  assert.equal((await fresh).stock, 9);
  assert.equal(api.request({ url: '/api/products/1' }), first, 'fresh completion must not remove unrelated pending GET');
  waiting[0](response({ stock: 10 }));
  assert.equal((await first).stock, 10);
});
test('forced reads fail instead of using another pending snapshot', async () => {
  let finishOld; let calls = 0;
  const api = setup(() => { calls++; if (calls === 1) return new Promise(resolve => { finishOld = resolve; }); return Promise.reject(new Error('failed to fetch')); });
  const old = api.request({ url: '/api/boards/BOARD-20261016-ABCDEF123456' });
  await assert.rejects(api.request({ url: '/api/boards/BOARD-20261016-ABCDEF123456', forceNetwork: true }));
  finishOld(response({ remainingQty: 5 }));
  assert.equal((await old).remainingQty, 5);
});
test('forceNetwork never disables duplicate protection for writes', async () => {
  let finish; const calls = [];
  const api = setup((url) => { calls.push(url); if (url.endsWith('/api/sync')) return Promise.resolve(response({ revision: 1 })); return new Promise(resolve => { finish = resolve; }); });
  const input = { url: '/api/products', method: 'POST', data: { name: 'fixture' }, forceNetwork: true };
  const first = api.request(input);
  assert.equal(api.request(input), first);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish(response({ id: 1 })); await first;
  assert.equal(calls.filter(url => url.endsWith('/api/products')).length, 1);
});
