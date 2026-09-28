const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('ledger page separates loading, load failure and empty results', () => {
  const source = fs.readFileSync('src/pages/ledger/index.tsx', 'utf8');
  assert.match(source, /const \[loading, setLoading\] = useState\(true\)/);
  assert.match(source, /const \[loadError, setLoadError\] = useState\(''\)/);
  assert.match(source, /setLoadError\(error instanceof Error \? error\.message : 'LOAD_FAILED'\)/);
  assert.match(source, /\{loading \? <View className=\{styles\.empty\}/);
  assert.match(source, /: loadError \? <View className=\{styles\.empty\} onClick=\{load\}/);
  assert.match(source, /: list\.length === 0 \? <View className=\{styles\.empty\}/);
});
