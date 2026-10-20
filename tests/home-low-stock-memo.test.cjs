const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('home reuses the shared workbench and exposes stock warnings', () => {
  const home = fs.readFileSync('src/pages/home/index.tsx', 'utf8');
  const workbench = fs.readFileSync('src/pages/business-center/workbench.tsx', 'utf8');
  assert.match(home, /<Workbench embedded initial='home' \/>/);
  assert.match(workbench, /data-testid='workbench-stock-notice'/);
  assert.match(workbench, /loadHomeSummary/);
});
