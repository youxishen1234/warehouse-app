const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('ledger page separates loading, load failure and empty results', () => {
  const source = fs.readFileSync('src/pages/ledger/index.tsx', 'utf8');
  assert.match(source, /const \[loading, setLoading\] = useState\(true\)/);
  assert.match(source, /const \[loadError, setLoadError\] = useState\(''\)/);
  assert.match(source, /setLoadError\(error instanceof Error \? error\.message : 'LOAD_FAILED'\)/);
  assert.match(source, /\{loading \? <View className=\{styles\.empty\}/);
  assert.match(source, /: loadError \? <View className=\{styles\.empty\}/);
  assert.match(source, /onClick=\{load\}>重新加载/);
  assert.match(source, /: filtered\.length === 0 \? <View className=\{styles\.empty\}/);
  assert.match(source, /const ready = !loading && !loadError/);
});

test('ledger deep links scope parties and retrieve exact entries without replacing the list', () => {
  const source = fs.readFileSync('src/pages/ledger/index.tsx', 'utf8');
  assert.match(source, /params\.party_type === 'customer' \|\| params\.party_type === 'supplier'/);
  assert.match(source, /party_type: party\.type, party_id: party\.id/);
  assert.match(source, /getLedger\(\{ id: entryId, include_voided: true \}\)/);
  assert.match(source, /const scoped = party\s*\?\s*data\s*\.filter\(entry => entry\.party_id === party\.id/);
  assert.match(source, /const clearParty = \(\) => \{[\s\S]*setPeriod\('本月'\)[\s\S]*setRange\(monthRange\(\)\)/);
  assert.match(source, /party \? '清除对象筛选' : '重置'/);
});
