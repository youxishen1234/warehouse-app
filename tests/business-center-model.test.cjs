const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const model = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/pages/business-center/model.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText, { exports: model });

test('business totals exclude voided shipments and never merge unrelated delivery notes', () => {
  const order = { id: 1, quantity: 50 };
  const rows = [
    { id: 1, type: 'out', order_id: 1, customer_id: 1, quantity: 10, outbound_no: 'CK-1', created_at: 1 },
    { id: 2, type: 'out', order_id: 1, customer_id: 1, quantity: 20, outbound_no: 'CK-1', created_at: 2, voided_at: 3 },
    { id: 3, type: 'out', order_id: 2, customer_id: 2, quantity: 5, outbound_no: 'CK-1', created_at: 3 },
    { id: 4, type: 'in', order_id: 1, quantity: 1000, created_at: 4 }
  ];
  assert.equal(model.remainingOrder(order, rows), 40);
  assert.equal(model.groupShipments(rows).length, 2);
});
test('customer overview retains account-only clients and flags ambiguous name matches', () => {
  const rows = model.mergeCustomers([{ id: 'd1', name: '同名公司', specs: [] }], [
    { id: 1, name: '同名公司' }, { id: 2, name: '同名公司' }, { id: 3, name: '仅账款客户' }, { id: 4, name: '停用客户', deleted_at: 1 }
  ]);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].ambiguous, true);
  assert.equal(rows[0].account, undefined);
  assert.equal(rows.some(c => c.name === '仅账款客户'), true);
});
test('duplicate dimension companies never claim the same customer account', () => {
  const rows = model.mergeCustomers([{ id: 'a', name: '重复公司', specs: [] }, { id: 'b', name: ' 重复公司 ', specs: [] }], [{ id: 1, name: '重复公司' }]);
  assert.equal(rows.filter(row => row.account).length, 1);
  assert.equal(rows.filter(row => row.dimension).every(row => row.ambiguous && !row.account), true);
});
test('specification inventory requires matching material and unit; ambiguous products stay separate', () => {
  const spec = { size: '40 × 30 × 20', sizeUnit: 'cm', unit: '个', kind: '成品', material: '五层', goods: '' };
  const products = [
    { id: 1, specification: '40x30x20 cm', unit: '个', material: '五层' },
    { id: 2, specification: '40x30x20 cm', unit: '个', material: '三层' },
    { id: 3, specification: '40x30x20 mm', unit: '个', material: '五层' },
    { id: 4, specification: '40x30x20 cm', unit: '个', material: '五层' }
  ];
  assert.deepEqual(Array.from(model.matchingProducts(spec, products), p => p.id), [1, 4]);
  assert.equal(model.matchingProducts({ ...spec, kind: '纸板' }, products).length, 0);
  assert.equal(model.matchesQuery('40*30*20', [spec.size]), true);
});
