const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('carton calculator sanitizes dimension and thickness inputs consistently', () => {
  const source = fs.readFileSync('src/pages/carton-calculator/index.tsx', 'utf8');
  assert.match(source, /sanitizeDimensionInput/);
  const math = fs.readFileSync('src/pages/carton-calculator/math.ts', 'utf8');
  assert.match(math, /function sanitizeDimensionInput\(value: string\)/);
  assert.match(math, /sanitizeDecimalInput\(value, 6\)/);
  assert.match(math, /numeric <= MAX_QUANTITY_VALUE/);
  assert.match(source, /dimensions\[key\].*sanitizeDimensionInput\(event\.detail\.value\)/);
  assert.match(source, /setThickness\(sanitizeDimensionInput\(event\.detail\.value\)/);
});
