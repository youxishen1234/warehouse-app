const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const test = require('node:test');

const source = fs.readFileSync(path.resolve('src/pages/carton-calculator/math.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const api = {};
vm.runInNewContext(compiled, { exports: api, require: () => require(path.resolve('backend/stock-math.js')) });

test('carton preview uses shared rounding and rejects non-positive dimensions', () => {
  assert.equal(api.parseDimension('1200.25'), 1200.25);
  assert.equal(api.parseDimension('0'), null);
  assert.equal(api.parseDimension('-2'), null);
  assert.equal(api.parseDimension('1e3'), 1000);
  assert.equal(api.calculateTargetDimension(1200.1234567, 1.5, 'inner'), 1203.123457);
  assert.equal(api.calculateTargetDimension(1203.123457, 1.5, 'outer'), 1200.123457);
  assert.equal(api.formatDimension(1203.126), '1203.13');
});
