const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const compiled = ts.transpileModule(fs.readFileSync(path.resolve('src/utils/format.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const formatter = {};
vm.runInNewContext(compiled, { exports: formatter });

test('money display keeps one symbol, direction, separators and two decimals', () => {
  for (const [value, expected] of [[0, '¥0.00'], [12.3, '¥12.30'], [12345.67, '¥12,345.67'], [-7.25, '¥-7.25']]) {
    assert.equal(formatter.formatMoney(value), expected);
  }
  for (const value of [NaN, Infinity, -Infinity, 'not-a-number']) assert.equal(formatter.formatMoney(value), '¥0.00');
});

test('editable amounts retain two decimals without symbols or grouping', () => {
  for (const value of [0, 1.2, 12345.67, -7.25]) {
    const result = formatter.formatMoneyInput(value);
    assert.equal(result, value.toFixed(2));
    assert.match(result, /^-?\d+\.\d{2}$/);
    assert.equal(Number(result), value);
  }
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(formatter.formatMoneyInput(value), '0.00');
});

test('time formatting follows local time and invalid timestamps use a placeholder', () => {
  const timestamp = new Date(2026, 8, 27, 9, 5).getTime();
  assert.equal(formatter.formatTime(timestamp), '2026-09-27 09:05');
  assert.equal(formatter.formatShortTime(timestamp), '09/27 09:05');
  for (const value of [NaN, Infinity, -Infinity, 8640000000000001, 'invalid']) {
    assert.equal(formatter.formatTime(value), '时间未知');
    assert.equal(formatter.formatShortTime(value), '时间未知');
  }
});

test('stock status treats zero safety as an out-of-stock-only threshold', () => {
  for (const [stock, safety, label, color] of [[0, 0, '缺货', '#dc2626'], [0.000001, 0, '正常', '#16a34a'], [0, 5, '缺货', '#dc2626'], [4, 5, '偏低', '#d97706']]) {
    const result = formatter.getStockStatus(stock, safety);
    assert.equal(result.label, label);
    assert.equal(result.color, color);
  }
});
