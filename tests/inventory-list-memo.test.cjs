const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('legacy inventory route opens the current stock panel without legacy card actions', () => {
  const source = fs.readFileSync('src/pages/inventory/index.tsx', 'utf8');
  const workbench = fs.readFileSync('src/components/Workspace/workbench.tsx', 'utf8');
  assert.match(source, /import Workbench from '\@\/components\/Workspace\/workbench'/);
  assert.match(source, /<Workbench embedded initial='stock' \/>/);
  assert.doesNotMatch(source, /编辑库存|SwipeRow|visibleList/);
  assert.match(workbench, /routePath === 'pages\/inventory\/index'/);
  assert.match(workbench, /routePath === 'inventory\/index'/);
  assert.match(workbench, /<StockList kind=\{kind\}/);
  assert.match(fs.readFileSync('src/components/Workspace/stock-list.tsx', 'utf8'), /data-testid='workbench-board'/);
  assert.equal(fs.existsSync('src/pages/board-stock/index.tsx'), false);
});
