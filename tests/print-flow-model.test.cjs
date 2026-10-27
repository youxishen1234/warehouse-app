const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, dependencies) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require(id) {
      if (!Object.hasOwn(dependencies, id)) throw new Error('Unexpected dependency: ' + id);
      return dependencies[id];
    }
  });
  return exports;
}

test('copy-as-new preserves business lines but drops old document and outbound identities', () => {
  const model = load('src/pages/print-center/model.ts', {
    '../../../backend/print-notes': require('../backend/print-notes'),
    '@/utils/stock-math': { localDate: () => '2026-10-26' },
    '@/utils/dot-matrix-print': {}
  });
  const original = {
    id: 17, number: 'SH-20261023-00017', version: 4, created_at: 1000, updated_at: 2000,
    outbound_at: 3000, outbound_no: 'OUT-17', transaction_ids: [51],
    company: '曙光纸箱', customer_id: 8, customer_name: '华兴包装',
    address: '东光县', phone: '13800000000', receiver: '王先生', sender: '张师傅',
    date: '2026-10-23', paper: '241-93',
    items: [{ product_id: 5, name: '纸箱', specification: '30x20x15', unit: '个', quantity: 100, price: 3.5, amount: 350, remark: '轻拿轻放' }],
    total: 350
  };
  const first = model.copyNoteDraft(original);
  const second = model.copyNoteDraft(original);
  for (const key of ['id', 'number', 'version', 'created_at', 'updated_at', 'outbound_at', 'outbound_no', 'transaction_ids']) {
    assert.equal(Object.hasOwn(first, key), false, 'new draft must not carry ' + key);
  }
  assert.equal(first.date, '2026-10-26');
  assert.equal(first.customer_id, original.customer_id);
  assert.equal(first.customer_name, original.customer_name);
  assert.equal(first.items[0].product_id, 5);
  assert.equal(first.items[0].quantity, '100');
  assert.equal(first.items[0].specification, '30×20×15');
  assert.notEqual(first.items[0].key, second.items[0].key);
  first.items[0].quantity = '2';
  assert.equal(original.items[0].quantity, 100, 'editing the copy cannot modify the original');
});

test('automatic outbound printing is opt-in and resets only when the printer pairing changes', () => {
  const storage = new Map();
  const taro = { default: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value)
  } };
  const pending = load('src/services/print-transport-pending.ts', { '@tarojs/taro': taro });
  const api = load('src/services/remote-print.ts', {
    '@tarojs/taro': taro,
    './print-transport-pending': pending,
    './request': {}
  });
  assert.equal(api.readPrintAfterOutbound(), false);
  storage.set('warehouse_print_after_outbound_v1', 'true');
  assert.equal(api.readPrintAfterOutbound(), false, 'only an explicit boolean opt-in is honored');
  api.savePrintPair('a'.repeat(64));
  api.savePrintAfterOutbound(true);
  assert.equal(api.readPrintAfterOutbound(), true);
  api.savePrintPair('a'.repeat(64));
  assert.equal(api.readPrintAfterOutbound(), true, 'reconnecting the same printer preserves the choice');
  api.savePrintPair('b'.repeat(64));
  assert.equal(api.readPrintAfterOutbound(), false, 'a different printer requires a fresh opt-in');
  api.savePrintAfterOutbound(true);
  api.savePrintPair('');
  assert.equal(api.readPrintAfterOutbound(), false, 'disconnecting clears automatic dispatch');
});
