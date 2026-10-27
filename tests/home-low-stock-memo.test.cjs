const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('home reuses the shared workbench without a stock warning surface or fetch', () => {
  const home = fs.readFileSync('src/pages/home/index.tsx', 'utf8');
  const workbench = fs.readFileSync('src/pages/business-center/workbench.tsx', 'utf8');
  const styles = fs.readFileSync('src/pages/business-center/workbench.module.scss', 'utf8');
  assert.match(home, /<Workbench embedded initial='home' \/>/);
  assert.match(workbench, /loadHomeSummary/);
  assert.match(workbench, /setStats\(await getStats\(\)\)/);
  assert.doesNotMatch(workbench, /lowStock|loadProducts\(true\)|库存预警|库存提醒|workbench-stock-notice/);
  assert.doesNotMatch(styles, /stockNotice|noticeTitle|noticeDetail|noticeAction|alertValue/);
  assert.match(workbench, /data-testid='workbench-summary'/);
  assert.equal((workbench.match(/<View className=\{styles\.summaryItem\}>/g) || []).length, 2);
});
