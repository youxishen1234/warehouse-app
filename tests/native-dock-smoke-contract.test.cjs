const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');

test('native dock smoke accepts the native/fallback visibility contract', () => {
  const source = fs.readFileSync('ios/App/App/NativeGlassTabBar.swift', 'utf8');
  assert.match(source, /dock\.isHidden == !nativeGlass/);
  assert.doesNotMatch(source, /dock\.isHidden != nativeGlass/);
  // Appearance belongs to original compositor-image review, and interaction
  // belongs to XCUITest. Requiring the old UIView/UITabBarAppearance backing
  // only enforced an implementation already shown to render a light dock.
  assert.doesNotMatch(source, /dock\.insertSubview/);
  assert.equal((source.match(/@available\(iOS 18\.0, \*\)/g) || []).length, 2);
});
