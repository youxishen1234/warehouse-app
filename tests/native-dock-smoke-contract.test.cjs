const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');

test('native dock smoke accepts the native/fallback visibility contract', () => {
  const source = fs.readFileSync('ios/App/App/NativeGlassTabBar.swift', 'utf8');
  assert.match(source, /dock\.isHidden == !nativeGlass/);
  assert.doesNotMatch(source, /dock\.isHidden != nativeGlass/);
});
