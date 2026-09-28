const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('stock product picker memoizes visible option rows', () => {
  const source = fs.readFileSync('src/components/StockProductPicker/index.tsx', 'utf8');
  assert.match(source, /const ProductOption = React\.memo\(function ProductOption/);
  assert.match(source, /const selectProduct = useCallback\(/);
  assert.match(source, /matches\.slice\(0, 50\)\.map\(product => <ProductOption/);
  assert.match(source, /onSelect=\{selectProduct\}/);
  assert.doesNotMatch(source, /matches\.slice\(0, 50\)\.map\(product => <View/);
});
