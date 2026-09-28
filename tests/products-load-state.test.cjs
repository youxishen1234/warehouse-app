const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('products page keeps loading, error and empty states distinct', () => {
  const source = fs.readFileSync('src/pages/products/index.tsx', 'utf8');
  assert.match(source, /const \[loading, setLoading\] = useState\(true\)/);
  assert.match(source, /const \[loadError, setLoadError\] = useState\(''\)/);
  assert.match(source, /setLoadError\(error instanceof Error \? error\.message : '商品加载失败，请点击重试'\)/);
  assert.match(source, /\{loading \? \(/);
  assert.match(source, /\) : loadError \? \(/);
  assert.match(source, /onClick=\{load\}/);
  assert.match(source, /\) : list\.length === 0 \? \(/);
});
