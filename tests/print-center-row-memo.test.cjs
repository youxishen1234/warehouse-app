const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('print center memoizes transaction rows while paging and printing', () => {
  const source = fs.readFileSync('src/pages/print-center/index.tsx', 'utf8');
  assert.match(source, /const PrintTransactionRow = React\.memo\(function PrintTransactionRow/);
  assert.match(source, /list\.map\(item => <PrintTransactionRow/);
  assert.match(source, /PrintTransactionRow key=\{item\.id\} item=\{item\}/);
  assert.doesNotMatch(source, /list\.map\(item => \(\s*<View className=\{styles\.row\}/);
});
