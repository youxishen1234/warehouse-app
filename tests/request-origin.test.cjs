const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const PRIMARY = 'http://152.136.100.200';
const FALLBACK = 'https://youxishen.online';
const response = (status = 200, data = []) => new Response(JSON.stringify({ success: status < 400, data, message: status >= 400 ? '暂时不可用' : undefined }), { status, headers: { 'Content-Type': 'application/json', 'X-Warehouse-Revision': '1' } });
const defer = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function setup(fetch, preferred) {
  const storage = new Map(preferred ? [['sg_custom_base', preferred]] : []);
  const downloads = [];
  const current = { token: 'isolated-origin-test-token', user: { id: 'fixture' } };
  const taro = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    showToast: () => {},
    downloadFile: async options => { downloads.push(options); return { statusCode: 200, tempFilePath: 'isolated.csv' }; },
    shareFileMessage: async () => {}
  };
  const session = { TEAM_ORIGIN: PRIMARY, PUBLIC_ORIGIN: FALLBACK, sessionOrigin: () => PRIMARY, session: () => current, setSession: () => {}, watchSession: () => {}, deviceId: () => 'test-device' };
  const modules = { '@tarojs/taro': { default: taro }, './session': session, './shared-refresh': { refreshSharedData: () => {} } };
  function load(filename) {
    const output = { exports: {} };
    const code = ts.transpileModule(fs.readFileSync(path.resolve('src/services', filename), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { exports: output.exports, module: output, require: id => { assert(id in modules, `unexpected dependency ${id}`); return modules[id]; }, fetch, AbortController, URL, setTimeout, clearTimeout, process: { env: { NODE_ENV: 'production' } }, console }, { filename });
    return output.exports;
  }
  const api = load('request.ts');
  modules['./request'] = api;
  return { api, download: load('download.ts'), downloads, storage, current };
}

test('configured address applies to business reads and downloads immediately', async () => {
  const urls = [];
  const { api, download, downloads, storage, current } = setup(async (url, options) => { urls.push(url); assert.equal(options.headers.Authorization, `Bearer ${current.token}`); return response(); }, FALLBACK);
  assert.equal(api.getBaseUrl(), FALLBACK);
  await api.request({ url: '/api/products' });
  await download.downloadCsv('/api/export/transactions.csv', 'records.csv');
  assert.equal(urls[0], FALLBACK + '/api/products');
  assert.equal(downloads[0].url, FALLBACK + '/api/export/transactions.csv');
  assert.equal(downloads[0].header.Authorization, `Bearer ${current.token}`);
  api.setBaseUrl(PRIMARY);
  await api.request({ url: '/api/products' });
  assert.equal(urls.at(-1), PRIMARY + '/api/products');
  api.setBaseUrl('');
  assert.equal(api.getBaseUrl(), PRIMARY);
  assert(!storage.has('sg_custom_base'));
  assert.throws(() => api.setBaseUrl('https://untrusted.invalid'), /地址/);
  assert.equal(api.getBaseUrl(), PRIMARY);
});

test('server failure switches future reads and CSV downloads to the working origin', async () => {
  const urls = [];
  const { api, download, downloads } = setup(async url => { urls.push(url); return response(url.startsWith(PRIMARY) ? 503 : 200); });
  await api.request({ url: '/api/ledger' });
  assert.deepEqual(urls, [PRIMARY + '/api/ledger', FALLBACK + '/api/ledger']);
  assert.equal(api.getBaseUrl(), FALLBACK);
  await download.downloadCsv('/api/export/ledger.csv?type=income', 'ledger.csv');
  assert.equal(downloads[0].url, FALLBACK + '/api/export/ledger.csv?type=income');
  await api.request({ url: '/api/products' });
  assert.equal(urls.at(-1), FALLBACK + '/api/products');
});

test('late response from the old origin cannot reverse successful failover', async () => {
  const slow = defer();
  const { api } = setup(async url => url.endsWith('/slow') ? slow.promise : response(url.startsWith(PRIMARY) ? 503 : 200));
  const staleRead = api.request({ url: '/api/slow' });
  await api.request({ url: '/api/ledger' });
  assert.equal(api.getBaseUrl(), FALLBACK);
  slow.resolve(response());
  await staleRead;
  assert.equal(api.getBaseUrl(), FALLBACK);
});

test('a late health probe cannot undo a newer manual address selection', async () => {
  const slow = defer();
  const { api } = setup(async () => slow.promise);
  const health = api.autoBestBase();
  api.setBaseUrl(FALLBACK);
  slow.resolve(response(200, { online: true }));
  assert.equal(await health, FALLBACK);
  assert.equal(api.getBaseUrl(), FALLBACK);
});

test('a late business response cannot undo a newer manual address selection', async () => {
  const slow = defer();
  const { api } = setup(async () => slow.promise);
  const pending = api.request({ url: '/api/products' });
  api.setBaseUrl(FALLBACK);
  slow.resolve(response());
  await pending;
  assert.equal(api.getBaseUrl(), FALLBACK);
});

test('health probes prefer the selected route and failed probes leave it unchanged', async () => {
  const urls = [];
  const { api, storage } = setup(async url => { urls.push(url); return response(url.startsWith(PRIMARY) ? 200 : 503); }, FALLBACK);
  assert.equal(await api.autoBestBase(), PRIMARY);
  assert.deepEqual(urls, [FALLBACK + '/api/health', PRIMARY + '/api/health']);
  assert.equal(storage.get('sg_custom_base'), FALLBACK, 'automatic failover does not rewrite the explicit preference');
  const failed = setup(async () => response(503), FALLBACK);
  assert.equal(await failed.api.autoBestBase(), null);
  assert.equal(failed.api.getBaseUrl(), FALLBACK);
});

test('client validation errors do not retry against another origin', async () => {
  const urls = [];
  const { api } = setup(async url => { urls.push(url); return response(400); });
  await assert.rejects(api.request({ url: '/api/products?keyword=bad' }), /暂时不可用/);
  assert.deepEqual(urls, [PRIMARY + '/api/products?keyword=bad']);
  assert.equal(api.getBaseUrl(), PRIMARY);
});

test('untrusted stored addresses are ignored while legacy approved addresses migrate', async () => {
  const urls = [];
  const invalid = setup(async url => { urls.push(url); return response(); }, 'https://untrusted.invalid');
  await invalid.api.request({ url: '/api/products' });
  assert.deepEqual(urls, [PRIMARY + '/api/products']);
  const legacy = setup(async () => response(), PRIMARY + ':4000');
  assert.equal(legacy.api.getBaseUrl(), PRIMARY);
  assert.equal(legacy.storage.get('sg_custom_base'), PRIMARY);
});
