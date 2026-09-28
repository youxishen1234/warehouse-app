const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('orders page memoizes rows and keeps status handler stable', () => {
  const source = fs.readFileSync('src/pages/orders/index.tsx', 'utf8');
  assert.match(source, /const OrderListRow = React\.memo\(function OrderListRow/);
  assert.match(source, /const changeStatus = useCallback\(/);
  assert.match(source, /list\.map\(order => <OrderListRow/);
  assert.match(source, /history=\{events\[order\.id\] \|\| \[\]\}/);
  assert.match(source, /onStatusChange=\{changeStatus\}/);
  assert.doesNotMatch(source, /list\.map\(order => \{[\s\S]*<View className=\{styles\.item\}/);
});
