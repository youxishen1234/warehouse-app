const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

function loadDownloadHelper() {
  const source = fs.readFileSync('src/services/update-download.ts', 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 }
  }).outputText;
  const context = { exports: {}, setTimeout, Promise, Error };
  vm.runInNewContext(output, context);
  return context.exports;
}

test('download retries one transient failure with the same package contract', async () => {
  const helper = loadDownloadHelper();
  const attempts = [];
  const failures = [];
  const waits = [];
  const result = await helper.downloadBundleWithRetry(
    async attempt => {
      attempts.push(attempt);
      if (attempt === 1) throw new Error('Timed out downloading bundle');
      return { id: 'bundle-2', version: '20261027000000' };
    },
    failure => failures.push(failure),
    async milliseconds => waits.push(milliseconds)
  );

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(waits, [helper.UPDATE_DOWNLOAD_RETRY_DELAY]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, 'Timed out downloading bundle');
  assert.equal(result.bundle.id, 'bundle-2');
  assert.equal(result.bundle.version, '20261027000000');
  assert.equal(result.emptyBundle, false);
});

test('download reports final failure and empty bundles after exactly two attempts', async () => {
  const helper = loadDownloadHelper();
  const failures = [];
  const failed = await helper.downloadBundleWithRetry(
    async () => { throw new Error('network unavailable'); },
    failure => failures.push(failure),
    async () => {}
  );
  assert.equal(failed.bundle, null);
  assert.equal(failed.emptyBundle, false);
  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map(item => item.attempt), [1, 2]);

  const empty = await helper.downloadBundleWithRetry(
    async () => null,
    () => {},
    async () => {}
  );
  assert.equal(empty.bundle, null);
  assert.equal(empty.emptyBundle, true);
});

test('native and bootstrap download deadlines outlast the configured iOS response timeout', () => {
  const helper = loadDownloadHelper();
  const config = JSON.parse(fs.readFileSync(path.join('capacitor.config.json'), 'utf8'));
  const bootstrap = fs.readFileSync('src/index.html', 'utf8');

  assert.equal(config.plugins.CapacitorUpdater.responseTimeout, 180);
  assert.equal(helper.UPDATE_DOWNLOAD_TIMEOUT, 190000);
  assert.match(bootstrap, /},\s*190000,\s*'更新下载超时'\)/);
});
