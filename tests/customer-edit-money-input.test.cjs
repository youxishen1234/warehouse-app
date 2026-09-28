const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const test = require('node:test');

const source = fs.readFileSync(path.resolve('src/utils/form-input.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const api = {};
vm.runInNewContext(compiled, { exports: api, require: () => require(path.resolve('backend/stock-math.js')) });

test('balance input keeps two decimals and rejects sign, exponent and over-limit values', () => {
  assert.equal(api.sanitizeNonNegativeMoneyInput('123.456'), '123.45');
  assert.equal(api.sanitizeNonNegativeMoneyInput('0.'), '0.');
  assert.equal(api.sanitizeNonNegativeMoneyInput('-12'), '');
  assert.equal(api.sanitizeNonNegativeMoneyInput('+12'), '');
  assert.equal(api.sanitizeNonNegativeMoneyInput('1e5'), '');
  assert.equal(api.sanitizeNonNegativeMoneyInput('9'.repeat(20)), '');
});

test('customer edit binds the balance input to the shared non-negative money sanitizer', () => {
  const page = fs.readFileSync('src/pages/customer-edit/index.tsx', 'utf8');
  assert.match(page, /sanitizeNonNegativeMoneyInput\(e\.detail\.value\)/);
});
