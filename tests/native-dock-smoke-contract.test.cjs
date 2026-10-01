const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');

test('native dock smoke accepts the native/fallback visibility contract', () => {
  const source = fs.readFileSync('ios/App/App/NativeGlassTabBar.swift', 'utf8');
  assert.match(source, /dock\.isHidden == !nativeGlass/);
  assert.doesNotMatch(source, /dock\.isHidden != nativeGlass/);
  assert.match(source, /allowsBackForwardNavigationGestures\s*=\s*false/);
  assert.match(source, /webReady && pageCanGoBack && !routeIsTab && !modalVisible && !keyboardVisible && pendingIndex == nil/);
  assert.match(source, /pageCanGoBack = state\["canGoBack"\] as\? Bool \?\? false/);
  assert.match(source, /systemMaterialDark/);
  assert.match(source, /dock\.standardAppearance = appearance/);
  assert.match(source, /dock\.scrollEdgeAppearance = appearance/);
  assert.match(source, /let root = bridgeController\.view/);
  assert.match(source, /root\.addSubview\(backdrop\)/);
  assert.match(source, /backdrop\.isUserInteractionEnabled = false/);
  assert.match(source, /dockBackdrop\?\.isHidden = dock\.isHidden/);
  assert.doesNotMatch(source, /dock\.insertSubview/);
  assert.equal((source.match(/@available\(iOS 18\.0, \*\)/g) || []).length, 2);
});
