const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('customer and supplier routes stay on the current workbench without legacy shortcuts', () => {
  const source = fs.readFileSync('src/pages/customers/index.tsx', 'utf8');
  const suppliers = fs.readFileSync('src/pages/suppliers/index.tsx', 'utf8');
  assert.match(source, /import Workbench from '\@\/pages\/business-center\/workbench'/);
  assert.match(suppliers, /import Workbench from '\.\.\/business-center\/workbench'/);
  assert.doesNotMatch(source, /pages\/customer-edit\/index/);
  assert.doesNotMatch(source, /pages\/customer-photos\/index/);
  assert.doesNotMatch(source, /pages\/inbound\/index|pages\/outbound\/index|pages\/inventory\/index|pages\/products\/index/);
});
