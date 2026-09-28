const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('stock forms distinguish non-empty overflow previews from blank inputs', () => {
  const inbound = fs.readFileSync('src/pages/inbound/index.tsx', 'utf8');
  const outbound = fs.readFileSync('src/pages/outbound/index.tsx', 'utf8');
  for (const source of [inbound, outbound]) {
    assert.match(source, /金额超出支持范围，请减少数量或单价/);
    assert.match(source, /Number\.isFinite\(/);
    assert.match(source, /if \(!Number\.isFinite\(totalAmount\)\)/);
  }
});
