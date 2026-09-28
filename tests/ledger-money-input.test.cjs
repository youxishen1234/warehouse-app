const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const utilitySource = fs.readFileSync(path.resolve('src/utils/form-input.ts'), 'utf8');
const compiled = ts.transpileModule(utilitySource, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const utility = {};
vm.runInNewContext(compiled, { exports: utility, require: () => require(path.resolve('backend/stock-math.js')) });

test('ledger amount field uses the shared non-negative two-decimal input sanitizer', () => {
  const source = fs.readFileSync('src/pages/ledger/index.tsx', 'utf8');
  assert.match(source, /import \{ parseMoneyInput, previewMoneyInput, sanitizeNonNegativeMoneyInput \}/);
  assert.match(source, /setAmount\(sanitizeNonNegativeMoneyInput\(e\.detail\.value\)\)/);
  assert.match(source, /parseMoneyInput\(amount,[\s\S]*?true\)/);
  assert.match(source, /previewMoneyInput\(amount\)/);
  assert.match(source, /addLedger\(\{ type: kind, amount: value/);
});

test('ledger preview and write parser share the stock-math rounded amount', () => {
  for (const input of ['12', '12.3', '12.34']) {
    assert.equal(utility.previewMoneyInput(input), utility.parseMoneyInput(input, '金额', true));
  }
  assert.equal(utility.previewMoneyInput('12.345'), utility.parseMoneyInput(utility.sanitizeNonNegativeMoneyInput('12.345'), '金额', true));
  assert.equal(utility.previewMoneyInput(''), null);
  assert.equal(utility.previewMoneyInput('0'), null);
  assert.throws(() => utility.parseMoneyInput('-12', '金额', true));
});
