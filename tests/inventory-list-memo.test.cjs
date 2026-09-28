const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('inventory list rows are memoized and modal state is isolated', () => {
  const source = fs.readFileSync('src/pages/inventory/index.tsx', 'utf8');
  assert.match(source, /const InventoryListRow = React\.memo\(function InventoryListRow/);
  assert.match(source, /const openCount = useCallback\(/);
  assert.match(source, /if \(countSavingRef\.current\) return/);
  assert.match(source, /visibleList\.map\(product => <InventoryListRow/);
  assert.match(source, /latest=\{latestByProduct\.get\(product\.id\)\}/);
  assert.match(source, /onCount=\{openCount\}/);
  assert.doesNotMatch(source, /visibleList\.map\(p => \{[\s\S]*setCounting\(p\)/);
});
