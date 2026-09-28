const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('outbound recent transaction rows are memoized', () => {
  const source = fs.readFileSync('src/pages/outbound/index.tsx', 'utf8');
  assert.match(source, /const RecentOutboundRow = React\.memo\(function RecentOutboundRow/);
  assert.match(source, /recent\.map\(transaction => <RecentOutboundRow/);
  assert.match(source, /onVoid=\{voidRecent\}/);
  assert.doesNotMatch(source, /recent\.map\(transaction => <View className=\{styles\.recentItem\}/);
});
