const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('legacy customer and supplier routes render the current workbench', () => {
  const source = fs.readFileSync('src/pages/customers/index.tsx', 'utf8');
  const workbench = fs.readFileSync('src/pages/business-center/workbench.tsx', 'utf8');
  assert.match(source, /import Workbench from '\@\/pages\/business-center\/workbench'/);
  assert.match(source, /<Workbench\s*\/>/);
  assert.doesNotMatch(source, /quickLinks|customerPhotoQuickAction|LegacyCustomersPage|SwipeRow/);
  assert.match(workbench, /remote\.loadError/);
  assert.match(workbench, /remote\.loading/);
  assert.match(workbench, /remote\.ready/);
});
