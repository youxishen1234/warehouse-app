const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const exportsObject = {};
const source = fs.readFileSync('src/pages/business-center/daily-records.ts', 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: exportsObject, Date });
const { dailyRecords, localDay } = exportsObject;
const now = new Date(2026, 9, 19, 12).getTime();
const blank = () => ({ boards: [], production: [], transactions: [], ledger: [] });

test('empty warehouse does not fabricate sample activity', () => {
  assert.equal(dailyRecords(blank(), localDay(now)).length, 0);
});
test('today uses local calendar boundaries and sorts newest first', () => {
  const data = blank();
  data.ledger = [
    { id: 1, type: 'income', amount: 50, created_at: now - 1000 },
    { id: 2, type: 'income', amount: 20, created_at: new Date(2026, 9, 18, 23, 59).getTime() },
    { id: 3, type: 'income', amount: 10, created_at: now }
  ];
  const rows = dailyRecords(data, localDay(now));
  assert.equal(rows.map(r => r.id).join(','), 'ledger-3,ledger-1');
});
test('linked stock and accrual rows do not duplicate production and receipts', () => {
  const data = blank();
  data.boards = [{ id: 'B1', supplier: '板厂', boardLength: 160, boardWidth: 110, receivedQty: 100, createdAt: now }];
  data.production = [{ id: 'P1', product_name: '纸箱', specification: '40 × 30 × 20 cm', quantity: 8, unit: '个', created_at: now }];
  data.transactions = [{ id: 1, production_id: 'P1', type: 'in', quantity: 8, created_at: now }, { id: 2, type: 'out', quantity: 4, amount: 72, created_at: now }, { id: 3, type: 'out', voided_at: now, created_at: now }];
  data.ledger = [{ id: 1, type: 'payable', board_batch_id: 'B1', created_at: now }, { id: 2, type: 'receivable', transaction_id: 2, created_at: now }];
  const rows = dailyRecords(data, localDay(now));
  assert.equal(rows.length, 3);
  assert.equal(rows.find(r => r.id === 'production-P1').status, '已完工');
  assert.equal(rows.find(r => r.id === 'board-B1').value, 100);
  assert.equal(rows.find(r => r.id === 'transaction-2').target.ledger, 2);
});
test('customer receipts and supplier payments remain distinct', () => {
  const data = blank();
  data.ledger = [
    { id: 1, type: 'settlement', party_type: 'supplier', party_name: '供货商', amount: 50, created_at: now },
    { id: 2, type: 'settlement', party_type: 'customer', party_name: '客户', amount: 30, created_at: now },
    { id: 3, type: 'income', voided_at: now, amount: 20, created_at: now }
  ];
  const rows = dailyRecords(data, localDay(now));
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.id === 'ledger-1').status, '已付款');
  assert.equal(rows.find(r => r.id === 'ledger-2').status, '已收款');
});
test('missing amount stays a quantity instead of an invented price', () => {
  const data = blank(); data.transactions = [{ id: 1, type: 'out', quantity: 4, unit: '个', created_at: now }];
  const row = dailyRecords(data, localDay(now))[0];
  assert.equal(row.money, false); assert.equal(row.value, 4); assert.equal(row.unit, '个');
});
