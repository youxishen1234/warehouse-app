const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('orders page memoizes rows and keeps status handler stable', () => {
  const source = fs.readFileSync('src/features/customer-orders/index.tsx', 'utf8');
  assert.match(source, /const OrderListRow = React\.memo\(function OrderListRow/);
  assert.match(source, /const changeStatus = useCallback\(/);
  assert.match(source, /\.map\(order => <OrderListRow/);
  assert.match(source, /history=\{events\[order\.id\] \|\| \[\]\}/);
  assert.match(source, /onStatusChange=\{changeStatus\}/);
  assert.doesNotMatch(source, /\.map\(order => \{[\s\S]*<View className=\{styles\.item\}/);
});
