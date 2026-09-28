const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('team admin data distinguishes loading and retryable failure from empty lists', () => {
  const source = fs.readFileSync('src/pages/team/index.tsx', 'utf8');
  assert.match(source, /const \[loading, setLoading\] = useState\(true\)/);
  assert.match(source, /loadError, setLoadError\] = useState\(''\)/);
  assert.match(source, /setLoadError\(text\)/);
  assert.match(source, /\{loading \? <Text className=\"team-message\"\>/);
  assert.match(source, /loadError \? <Text className=\"team-message\" onClick=\{load\}/);
  assert.match(source, /members\.length === 0 \? <Text className=\"team-message\"/);
  assert.match(source, /events\.length === 0 \? <Text className=\"team-message\"/);
});
