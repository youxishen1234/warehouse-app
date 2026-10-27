const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('legacy customer and supplier routes render the current workbench', () => {
  const source = fs.readFileSync('src/pages/customers/index.tsx', 'utf8');
  const workbench = fs.readFileSync('src/pages/business-center/workbench.tsx', 'utf8');
  assert.match(source, /import Workbench from '\@\/pages\/business-center\/workbench'/);
  assert.match(source, /<Workbench\s*\/>/);
  assert.match(workbench, /type Panel\s*=\s*[^;]*'customers'/);
  assert.match(workbench, /routePath === 'pages\/customers\/index'/);
  assert.match(workbench, /routePath === 'customers\/index'/);
  assert.match(workbench, /section === 'customers'\s*\?\s*'customers'/);
  assert.match(workbench, /customers:\s*'客户管理'/);
  assert.match(workbench, /data-testid='workbench-customer-management'[^>]*onClick=\{\(\)\s*=>\s*open\('\/pages\/customers\/index'\)\}/);
  assert.doesNotMatch(workbench, /data-testid='workbench-customer-management'[^>]*openFinance\('customer'\)/);
  assert.match(workbench, /<CustomerCenter\b/);
  assert.match(workbench, /<FinanceCenter\b/);
  assert.doesNotMatch(source, /quickLinks|customerPhotoQuickAction|LegacyCustomersPage|SwipeRow/);
  assert.match(workbench, /remote\.loadError/);
  assert.match(workbench, /remote\.loading/);
  assert.match(workbench, /const hasSnapshot = data !== empty/);
  assert.match(workbench, /hasSnapshot \|\| panel === 'finance' \|\| panel === 'customers'/);
  assert.match(workbench, /data-testid='workbench-initial-loading'/);
  assert.match(workbench, /data-testid='workbench-sync-status'/);
});
