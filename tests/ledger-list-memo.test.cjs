const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('ledger list rows are memoized and form state keeps callbacks stable', () => {
  const source = fs.readFileSync('src/pages/ledger/index.tsx', 'utf8');
  assert.match(source, /const LedgerListRow = React\.memo\(function LedgerListRow/);
  assert.match(source, /const remove = useCallback\(/);
  assert.match(source, /list\.map\(entry => <LedgerListRow/);
  assert.match(source, /onRemove=\{remove\}/);
  assert.match(source, /label=\{types\.find\(item => item\.value === entry\.type\)\?\.label \|\|/);
  assert.doesNotMatch(source, /list\.map\(entry => <View className=\{styles\.item\}/);
});
