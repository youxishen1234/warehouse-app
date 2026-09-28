const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { lineAmount } = require('../backend/stock-math');

test('inbound and outbound previews delegate to the backend line amount rule', () => {
  const source = fs.readFileSync('src/utils/stock-math.ts', 'utf8');
  assert.match(source, /import \{ lineAmount \} from '..\/\.\.\/backend\/stock-math';/);
  assert.match(source, /return lineAmount\(q, p\);/);
  for (const [quantity, price, expected] of [
    [4, 2.5, 10],
    [0.125, 3.2, 0.4],
    [1.234567, 9.876543, lineAmount(1.234567, 9.876543)]
  ]) {
    assert.equal(lineAmount(quantity, price), expected);
  }
});

