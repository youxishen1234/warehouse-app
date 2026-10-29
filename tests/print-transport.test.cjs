const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function preferenceFixture(initial) {
  const storage = new Map(initial === undefined ? [] : [['warehouse_print_transport_v1', initial]]);
  let storageFailure = false;
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/services/print-transport.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    require: name => {
      assert.equal(name, '@tarojs/taro');
      return { default: {
        getStorageSync: key => { if (storageFailure) throw new Error('storage unavailable'); return storage.get(key); },
        setStorageSync: (key, value) => storage.set(key, value),
      } };
    },
  });
  return { api: exports, storage, failStorage: () => { storageFailure = true; } };
}

test('phones use the computer USB/network path until a Bluetooth choice is explicitly saved', () => {
  const fixture = preferenceFixture();
  assert.equal(fixture.api.readPreferredPrintTransport(true), 'network');
  fixture.api.savePreferredPrintTransport('bluetooth');
  assert.equal(fixture.api.readPreferredPrintTransport(true), 'bluetooth');
  fixture.api.savePreferredPrintTransport('network');
  assert.equal(fixture.api.readPreferredPrintTransport(true), 'network');
});

test('unsupported Bluetooth, unreadable settings and invalid preferences keep the network path available', () => {
  assert.equal(preferenceFixture('bluetooth').api.readPreferredPrintTransport(false), 'network');
  assert.equal(preferenceFixture('invalid').api.readPreferredPrintTransport(true), 'network');
  const fixture = preferenceFixture('bluetooth');
  fixture.failStorage();
  assert.equal(fixture.api.readPreferredPrintTransport(true), 'network');
});
