const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('customer and supplier routes stay on the current workbench without legacy shortcuts', () => {
  const source = fs.readFileSync('src/pages/customers/index.tsx', 'utf8');
  const management = fs.readFileSync('src/pages/management/index.tsx', 'utf8');
  assert.match(source, /import Workbench from '\@\/components\/Workspace\/workbench'/);
  assert.match(management, /import Workbench from '\@\/components\/Workspace\/workbench'/);
  assert.match(management, /isBusinessForm\(params.section\)/);
  assert.doesNotMatch(source, /quickLinks|navigateTo|legacy/i);
});
