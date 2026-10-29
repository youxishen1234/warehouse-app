const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('team admin data distinguishes loading and retryable failure from empty lists', () => {
  const source = fs.readFileSync('src/components/BusinessForms/TeamSettings/index.tsx', 'utf8');
  assert.match(source, /const \[loading, setLoading\] = useState\(true\)/);
  assert.match(source, /loadError, setLoadError\] = useState\(''\)/);
  assert.match(source, /setLoadError\(text\)/);
  assert.match(source, /\{loading \? <p>/);
  assert.match(source, /loadError \? <div className='demo-error' role='alert'/);
  assert.match(source, /onClick=\{\(\) => void load\(\)\}/);
  assert.match(source, /!members\.length \? <div className='demo-empty'/);
  assert.match(source, /!events\.length && <div className='demo-empty'/);
});
