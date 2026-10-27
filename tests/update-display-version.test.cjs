const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');

function loadUpdateService({ currentVersion, latestVersion }) {
  const requests = [];
  const downloads = [];
  const taro = {
    request: async ({ url }) => {
      requests.push(url);
      return { statusCode: 200, data: { success: true, data: { version: latestVersion, url: `releases/${latestVersion}.zip` } } };
    }
  };
  const updater = {
    current: async () => ({ bundle: { version: currentVersion } }),
    download: async options => { downloads.push(options); return { id: 'fixture-bundle', version: options.version }; }
  };
  const versionSource = fs.readFileSync('src/services/update-version.ts', 'utf8');
  const versionOutput = ts.transpileModule(versionSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 }
  }).outputText;
  const versionContext = { exports: {} };
  vm.runInNewContext(versionOutput, versionContext);
  const imports = {
    '@tarojs/taro': { __esModule: true, default: taro },
    '@/services/request': { getBaseUrl: () => 'https://youxishen.online' },
    '@/services/session': { deviceId: () => 'fixture-device', PUBLIC_ORIGIN: 'https://youxishen.online' },
    './update-download': { UPDATE_DOWNLOAD_TIMEOUT: 190000, downloadBundleWithRetry: async run => ({ bundle: await run(1), emptyBundle: false }) },
    './update-version': versionContext.exports,
    '@/config/release': { WEB_DISPLAY_VERSION: '1.1.136' }
  };
  const source = fs.readFileSync('src/services/update.ts', 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true }
  }).outputText;
  const context = {
    exports: {},
    require: name => { if (!(name in imports)) throw new Error(`Unexpected import: ${name}`); return imports[name]; },
    window: { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { CapacitorUpdater: updater } } },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    AbortController, Date, Promise, Error, setTimeout, clearTimeout, console
  };
  vm.runInNewContext(output, context);
  return { checkAndUpdate: context.exports.checkAndUpdate, requests, downloads };
}

test('latest update notice shows the fixed web release version, not timestamp bundle IDs', async () => {
  const internalVersion = '20261027025127';
  const service = loadUpdateService({ currentVersion: internalVersion, latestVersion: internalVersion });
  const result = await service.checkAndUpdate();

  assert.equal(result.hasUpdate, false);
  assert.equal(result.message, '已是最新版本 v1.1.136');
  assert.equal(result.message.includes(internalVersion), false);
  assert.match(service.requests[0], /current=20261027025127/);
  assert.deepEqual(service.downloads, []);
});

test('internal timestamp versions still drive newer checks and native bundle downloads', async () => {
  const currentVersion = '20261027025126';
  const latestVersion = '20261027025127';
  const service = loadUpdateService({ currentVersion, latestVersion });
  const result = await service.checkAndUpdate();

  assert.equal(result.hasUpdate, true);
  assert.equal(result.message, '更新已下载，请关闭后重新打开 App 生效');
  assert.match(service.requests[0], /current=20261027025126/);
  assert.equal(service.downloads.length, 1);
  assert.equal(service.downloads[0].url.startsWith(`https://youxishen.online/appupdate/releases/${latestVersion}.zip?t=`), true);
  assert.equal(service.downloads[0].version, latestVersion);
});
