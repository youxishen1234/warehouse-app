const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const model = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/pages/home/dashboard-model.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText, { exports: model, Date });

test('stock warnings match safety thresholds and exclude deleted goods', () => {
  assert.equal(model.isStockWarning({ stock: 0, safety_stock: 0 }), true);
  assert.equal(model.isStockWarning({ stock: 4, safety_stock: 5 }), true);
  assert.equal(model.isStockWarning({ stock: 5, safety_stock: 5 }), true);
  assert.equal(model.isStockWarning({ stock: 1, safety_stock: 0 }), false);
  assert.equal(model.isStockWarning({ stock: 6, safety_stock: 5 }), false);
  assert.equal(model.isStockWarning({ stock: 0, safety_stock: 5, deleted_at: 1 }), false);
});
