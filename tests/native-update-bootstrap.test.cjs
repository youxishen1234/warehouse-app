const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function bootstrap(preferred, stalled = '', downloadFailures = 0) {
  const html = fs.readFileSync('src/index.html', 'utf8');
  const script = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(item => item[1]).find(code => code.includes('var TU'));
  const storage = new Map(preferred === undefined ? [] : [['sg_custom_base', preferred]]);
  const requests = [], downloads = [];
  let finish;
  const scheduled = new Promise(resolve => { finish = resolve; });
  const never = () => new Promise(() => {});
  const updater = {
    notifyAppReady: async () => {},
    current: stalled === 'current' ? never : async () => ({ bundle: { version: '20261010011625' } }),
    list: stalled === 'list' ? never : async () => ({ bundles: [] }),
    download: async options => {
      downloads.push(options);
      if (downloads.length <= downloadFailures) throw new Error('fixture download timeout');
      return { id: 'fixture-bundle' };
    },
    next: async () => { finish(); return true; }
  };
  vm.runInNewContext(script, {
    window: { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { CapacitorUpdater: updater, App: { getInfo: stalled === 'native' ? never : async () => ({ version: '1.1.32' }) } } } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    document: { createElement: () => ({ style: {}, remove: () => {} }), body: { appendChild: () => {} } },
    AbortController, clearTimeout, setTimeout: (fn, ms) => setTimeout(fn, ms === 3200 ? 0 : 15),
    fetch: async (url, options) => {
      requests.push({ url, body: options?.body });
      if (stalled === 'check' && url.includes('/check?')) return never();
      return { ok: true, json: async () => url.includes('manifest.json') ? { version: '20261010105218', url: 'releases/fixture.zip' } : { success: true, data: { version: '20261010105218', url: 'releases/fixture.zip' } } };
    }
  });
  return { requests, downloads, storage, scheduled };
}

test('native startup uses the canonical domain for wrapped, legacy, malformed and absent storage', async () => {
  for (const value of [undefined, JSON.stringify({ data: 'http://152.136.100.200:4000' }), JSON.stringify({ data: 'https://youxishen.online' }), 'http://152.136.100.200', 'https://untrusted.invalid', '{broken']) {
    const result = bootstrap(value);
    await result.scheduled;
    assert.equal(result.downloads.length, 1);
    assert(result.requests.every(item => item.url.startsWith('https://youxishen.online/')));
    assert(result.downloads[0].url.startsWith('https://youxishen.online/appupdate/releases/fixture.zip'));
    if (value) assert.equal(JSON.parse(result.storage.get('sg_custom_base')).data, 'https://youxishen.online');
  }
});

test('stalled native metadata and bundle list do not prevent the startup update check', async () => {
  for (const stalled of ['current', 'native', 'list', 'check']) {
    const result = bootstrap(JSON.stringify({ data: 'https://youxishen.online' }), stalled);
    await result.scheduled;
    assert.equal(result.downloads.length, 1);
    if (stalled === 'check') assert(result.requests.some(item => item.url.includes('/manifest.json')));
  }
});

test('native startup retries one timed-out bundle download', async () => {
  const result = bootstrap(JSON.stringify({ data: 'https://youxishen.online' }), '', 1);
  await result.scheduled;
  assert.equal(result.downloads.length, 2);
  assert(result.requests.some(item => String(item.body || '').includes('download_failed')));
},{ concurrency: false });
