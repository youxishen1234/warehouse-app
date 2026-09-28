const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('inbound and outbound forms index products once for row previews and stock checks', () => {
  for (const file of ['src/pages/inbound/index.tsx', 'src/pages/outbound/index.tsx']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /const productMap = useMemo\(\(\) => new Map\(products\.map/);
    assert.doesNotMatch(source, /products\.find\(item => item\.id === line\.product_id\)/);
    assert.doesNotMatch(source, /products\.find\(product => product\.id === line\.product_id\)/);
  }
  assert.match(fs.readFileSync('src/pages/inbound/index.tsx', 'utf8'), /\[lines, productMap\]/);
  assert.match(fs.readFileSync('src/pages/outbound/index.tsx', 'utf8'), /\[lines, productMap\]/);
});
