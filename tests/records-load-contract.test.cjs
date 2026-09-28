const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('records page keeps loading, retryable error, empty and ready states atomic', () => {
  const source = fs.readFileSync('src/pages/records/index.tsx', 'utf8');
  assert.match(source, /useRemoteData/);
  assert.match(source, /await Promise\.all\(\[/, 'transactions and products must load as one ready gate');
  assert.match(source, /recordsInvalidDates/);
  assert.match(source, /recordsLoading/);
  assert.match(source, /throw new Error\(getCopy\('recordsLoadFailed'\)\)/, 'internal errors must use the Chinese retry copy');
  assert.match(source, /onClick=\{load\}/, 'error state must retry through the same load entry');
  assert.match(source, /list\.length === 0/, 'empty state must stay distinct from an error');
  assert.match(source, /loadError \? \(/, 'error state must stay distinct from an empty result');
  assert.doesNotMatch(source, /console\.(log|error).*load/i);
  assert.match(fs.readFileSync('src/hooks/useRemoteData.ts', 'utf8'), /sequence = useRef\(0\)/);
  assert.match(fs.readFileSync('src/hooks/useRemoteData.ts', 'utf8'), /mounted\.current/);
});
