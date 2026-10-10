const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const ORIGIN = 'https://youxishen.online';
const healthy = () => new Response(JSON.stringify({ success: true, data: { online: true, dataReadable: true, dataWritable: true } }));

function setup(fetch, preferred, online = true) {
  const storage = new Map(preferred ? [['sg_custom_base', preferred]] : []);
  const modules = {
    '@tarojs/taro': { default: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
      getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
      showToast: () => {}
    } },
    './shared-refresh': { refreshSharedData: () => {} }
  };
  function load(name) {
    const output = { exports: {} };
    const code = ts.transpileModule(fs.readFileSync(path.resolve('src/services', name + '.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, { exports: output.exports, module: output, require: id => { assert(id in modules, id); return modules[id]; }, fetch, navigator: { onLine: online }, URL, AbortController, setTimeout: fn => setTimeout(fn, 20), clearTimeout, process: { env: { NODE_ENV: 'production' } }, console });
    return output.exports;
  }
  const session = load('session');
  modules['./session'] = session;
  return { api: load('request'), session, storage };
}

test('all retired saved addresses migrate before health, session or business requests', async () => {
  for (const preferred of ['http://152.136.100.200', 'http://152.136.100.200:4000', '152.136.100.200:4000/', 'https://152.136.100.200']) {
    const urls = [];
    const { api, session, storage } = setup(async url => { urls.push(url); return healthy(); }, preferred);
    assert.equal(api.getBaseUrl(), ORIGIN);
    assert.equal(storage.get('sg_custom_base'), ORIGIN);
    assert.equal(session.TEAM_ORIGIN, ORIGIN);
    await api.checkServerHealth();
    await session.accountApi('/auth/guest', 'POST');
    session.setSession({ token: 'fixture', user: { id: 'test' } });
    await api.request({ url: '/api/stats' });
    assert.deepEqual(urls, [ORIGIN + '/api/health', ORIGIN + '/api/auth/guest', ORIGIN + '/api/stats']);
  }
});

test('health succeeds without a session and sends no authorization or business request', async () => {
  const { api, session } = setup(async (url, options) => {
    assert.equal(url, ORIGIN + '/api/health');
    assert.equal(options.headers, undefined);
    return healthy();
  });
  assert.equal(session.session(), null);
  await api.checkServerHealth();
});

test('stalled fetch and stalled JSON parsing settle even when abort is ignored', async () => {
  for (const fetch of [() => new Promise(() => {}), async () => ({ ok: true, json: () => new Promise(() => {}) })]) {
    const { api } = setup(fetch);
    await assert.rejects(api.checkServerHealth(), /连接超时/);
    assert.equal(await api.autoBestBase(), null);
  }
});

test('HTML success, offline health, and broken storage are not reported as connected', async () => {
  for (const body of ['<html>index</html>', JSON.stringify({ success: true, data: { online: false } }), JSON.stringify({ success: true, data: { online: true, dataWritable: false } })]) {
    const { api } = setup(async () => new Response(body));
    await assert.rejects(api.checkServerHealth(), /服务器/);
    assert.equal(await api.autoBestBase(), null);
  }
});

test('offline and HTTP errors are explicit and never fall back to the retired server', async () => {
  await assert.rejects(setup(() => { throw new Error('must not fetch'); }, undefined, false).api.checkServerHealth(), /网络未连接/);
  const urls = [];
  const { api } = setup(async url => { urls.push(url); return new Response('', { status: 503 }); });
  await assert.rejects(api.checkServerHealth(), /HTTP 503/);
  assert.equal(await api.autoBestBase(), null);
  assert.deepEqual(urls, [ORIGIN + '/api/health', ORIGIN + '/api/health']);
});
