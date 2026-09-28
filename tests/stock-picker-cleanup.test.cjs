const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('stock product picker clears temporary search state when closed', () => {
  const source = fs.readFileSync('src/components/StockProductPicker/index.tsx', 'utf8');
  assert.match(source, /const closePicker = \(\) =>/);
  assert.match(source, /setOpen\(false\)/);
  assert.match(source, /setQuery\(''\)/);
  assert.match(source, /setFilterQuery\(''\)/);
  assert.match(source, /if \(open\) closePicker\(\); else setOpen\(true\)/);
});

test('stock product picker keeps product filtering stable when excluded array identity changes', () => {
  const source = fs.readFileSync('src/components/StockProductPicker/index.tsx', 'utf8');
  assert.match(source, /const excludedKey = \[\.\.\.new Set\(excluded\)\]\.sort/);
  assert.match(source, /useMemo\(\(\) => new Set\(excludedKey/);
  assert.match(source, /\[products, excludedIds, keyword\]/);
  assert.doesNotMatch(source, /products\.filter\(product => !excluded\.includes/);
});
