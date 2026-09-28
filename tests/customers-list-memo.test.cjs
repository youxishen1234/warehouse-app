const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('customer and supplier rows are memoized with stable row callbacks', () => {
  const source = fs.readFileSync('src/pages/customers/index.tsx', 'utf8');
  assert.match(source, /const CustomerListRow = React\.memo\(function CustomerListRow/);
  assert.match(source, /const handleActiveChange = useCallback\(/);
  assert.match(source, /const handleRecords = useCallback\(/);
  assert.match(source, /const handleEdit = useCallback\(/);
  assert.match(source, /const openSettlement = useCallback\(/);
  assert.match(source, /const handleDelete = useCallback\(/);
  assert.match(source, /list\.map\(party => <CustomerListRow/);
  assert.match(source, /onOpenChange=\{handleActiveChange\}/);
  assert.doesNotMatch(source, /list\.map\(c => \{[\s\S]*<SwipeRow/);
});
