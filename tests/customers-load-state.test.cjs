const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('customer and supplier pages keep loading and error states separate from empty state', () => {
  const source = fs.readFileSync('src/pages/customers/index.tsx', 'utf8');
  assert.match(source, /const \[loading, setLoading\] = useState\(true\)/);
  assert.match(source, /const \[loadError, setLoadError\] = useState\(''\)/);
  assert.match(source, /setLoading\(true\)/);
  assert.match(source, /setLoadError\(''\)/);
  assert.match(source, /setLoadError\(error instanceof Error \? error\.message : `\$\{label\}加载失败，请点击重试`\)/);
  assert.match(source, /\{loading \? \(/);
  assert.match(source, /\) : loadError \? \(/);
  assert.match(source, /onClick=\{\(\) => load\(true\)\}/);
  assert.match(source, /\) : list\.length === 0 \? \(/);
});
