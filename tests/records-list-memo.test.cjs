const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('records list rows are memoized and product names use a lookup map', () => {
  const source = fs.readFileSync('src/pages/records/index.tsx', 'utf8');
  assert.match(source, /const RecordListRow = React\.memo\(function RecordListRow/);
  assert.match(source, /const productNames = useMemo\(\(\) => new Map\(products\.map/);
  assert.match(source, /list\.map\(transaction => <RecordListRow/);
  assert.match(source, /productLabel=\{transaction\.product_name \|\| productNames\.get\(transaction\.product_id\)/);
  assert.doesNotMatch(source, /products\.find\(p => p\.id === id\)/);
});
