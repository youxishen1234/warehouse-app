const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('ledger page separates loading, load failure and empty results', () => {
  const source = fs.readFileSync('src/components/FinanceCenter/index.tsx', 'utf8');
  assert.match(source, /loading: boolean/);
  assert.match(source, /loadError: string/);
  assert.match(source, /\{loading \? <View className=\{styles\.empty\}/);
  assert.match(source, /: loadError \? <View className=\{styles\.empty\}/);
  assert.match(source, /onClick=\{\(\) => void onReload\(\)\}>重新加载/);
  assert.match(source, /groups\.length === 0 \? <View className=\{styles\.empty\}/);
  assert.match(source, /data-testid='finance-center'/);
});

test('ledger deep links scope parties and retrieve exact entries without replacing the list', () => {
  const source = fs.readFileSync('src/components/FinanceCenter/index.tsx', 'utf8');
  const workbench = fs.readFileSync('src/pages/business-center/workbench.tsx', 'utf8');
  assert.match(source, /partyType\?: PartyType/);
  assert.match(source, /partyId\?: number/);
  assert.match(source, /getLedger\(\{ id: entryId, include_voided: true \}\)/);
  assert.match(source, /Number\(item\.party_id\) === selectedId/);
  assert.match(workbench, /partyType=\{params\.party_type/);
  assert.match(workbench, /entryId=\{financeEntryId\}/);
  assert.equal(fs.existsSync('src/pages/ledger/index.tsx'), false);
});
