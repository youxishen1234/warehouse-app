const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('product store shares concurrent reads and supports invalidation', () => {
  const source = fs.readFileSync('src/services/product-store.ts', 'utf8');
  assert.match(source, /pending: Promise<Product\[\]> \| null/);
  assert.match(source, /if \(!force && pending\) return pending/);
  assert.match(source, /export function invalidateProducts/);
  assert.match(fs.readFileSync('src/pages/home/index.tsx', 'utf8'), /loadProducts\(force\)/);
});
