const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('home low-stock rows are memoized', () => {
  const source = fs.readFileSync('src/pages/home/index.tsx', 'utf8');
  assert.match(source, /const LowStockRow = React\.memo\(function LowStockRow/);
  assert.match(source, /lowStockList\.map\(product => <LowStockRow/);
  assert.match(source, /const status = getStockStatus\(product\.stock, product\.safety_stock\)/);
  assert.doesNotMatch(source, /lowStockList\.map\(product => \{[\s\S]*getStockStatus/);
});
