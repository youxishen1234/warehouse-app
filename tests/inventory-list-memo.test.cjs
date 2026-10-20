const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('legacy inventory route opens the current stock panel without legacy card actions', () => {
  const source = fs.readFileSync('src/pages/inventory/index.tsx', 'utf8');
  const workbench = fs.readFileSync('src/pages/business-center/workbench.tsx', 'utf8');
  assert.match(source, /import Workbench from '\@\/pages\/business-center\/workbench'/);
  assert.match(source, /<Workbench embedded initial='stock' \/>/);
  assert.doesNotMatch(source, /编辑库存|SwipeRow|visibleList/);
  assert.match(workbench, /route === '\/pages\/inventory\/index'/);
  assert.match(workbench, /data-testid='workbench-board'/);
});
