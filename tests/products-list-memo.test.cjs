const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('products page memoizes list rows and keeps action callbacks stable', () => {
  const source = fs.readFileSync('src/components/BusinessForms/GoodsCatalog/index.tsx', 'utf8');
  assert.match(source, /const ProductListRow = React\.memo\(function ProductListRow/);
  assert.match(source, /const handleActiveChange = useCallback\(/);
  assert.match(source, /const handleEdit = useCallback\(/);
  assert.match(source, /const handleDelete = useCallback\(/);
  assert.match(source, /const handleImage = useCallback\(/);
  assert.match(source, /list\.map\(product => <ProductListRow/);
  assert.match(source, /onActiveChange=\{handleActiveChange\}/);
  assert.doesNotMatch(source, /pages\/product-edit\/index/);
  assert.match(source, /const saveProduct = async/);
  assert.match(source, /className=\{styles\.editorSheet\}/);
});
