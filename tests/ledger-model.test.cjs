const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const { parseDateQuery } = require('../backend/date-query');

const model = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/pages/ledger/model.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText, { exports: model });
const entry = (id, type, amount, extra = {}) => ({ id, type, amount, remark: '', created_at: new Date(2026, 9, 3, 12).getTime(), ...extra });

test('cash-flow totals use cents, exclude voids, and do not double-count accruals or settlements', () => {
  const totals = model.summarizeLedger([
    entry(1, 'income', 0.1), entry(2, 'income', 0.2), entry(3, 'expense', 0.1),
    entry(4, 'receivable', 1000), entry(5, 'payable', 500), entry(6, 'settlement', 700),
    entry(7, 'income', 99999, { voided_at: Date.now() })
  ]);
  assert.equal(totals.income, 0.3);
  assert.equal(totals.net, 0.2);
  assert.equal(totals.receivable, 1000);
  assert.equal(totals.payable, 500);
  assert.equal(totals.settlement, 700);
  for (const kind of ['receivable', 'payable', 'settlement']) assert.equal(model.amountPrefix(kind), '');
});

test('inclusive date filters agree with the backend at both midnight boundaries', () => {
  const bounds = model.dateBounds('2026-10-01', '2026-10-03');
  const serverFrom = parseDateQuery(String(bounds.from));
  const serverTo = parseDateQuery(String(bounds.to), true);
  assert.equal(serverFrom, new Date(2026, 9, 1).getTime());
  assert.equal(serverTo, new Date(2026, 9, 3, 23, 59, 59, 999).getTime());
  assert(new Date(2026, 9, 4).getTime() > serverTo, 'the next day must not leak into results or exports');
  assert.equal(model.dateBounds('', '').from, undefined);
  assert.equal(model.dateBounds('', '').to, undefined);
  assert.equal(model.monthRange(-1, new Date(2026, 0, 15)).from, '2025-12-01');
  assert.equal(model.monthRange(0, new Date(2024, 1, 1)).to, '2024-02-29');
});

test('search and category filters intersect without reordering or including voided entries', () => {
  const entries = [entry(1, 'income', 100, { party_name: 'ABC 包装' }), entry(2, 'expense', 20, { remark: 'ABC 运费' }), entry(3, 'income', 10, { party_name: 'ABC 包装', voided_at: Date.now() })];
  assert.deepEqual(Array.from(model.filterLedger(entries, 'income', ' abc '), row => row.id), [1]);
  assert.deepEqual(Array.from(model.filterLedger(entries, '', '运费'), row => row.id), [2]);
});

test('daily groups sort by time and id without merging the same date across years', () => {
  const rows = [entry(1, 'income', 1), entry(2, 'expense', 2), entry(3, 'income', 3, { created_at: new Date(2025, 9, 3, 12).getTime() })];
  const groups = model.groupLedger(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].date, '2026-10-03');
  assert.deepEqual(Array.from(groups[0].entries, row => row.id), [2, 1]);
  assert.equal(rows[0].id, 1, 'grouping must not mutate the source list');
});

test('business-linked entries stay protected while party settlements become voidable', () => {
  assert.equal(model.isLinkedEntry(entry(1, 'income', 1)), false);
  // 交易/送货单关联的账务必须走原单作废。
  for (const link of ['transaction_id', 'delivery_note_id']) assert.equal(model.isLinkedEntry(entry(1, 'receivable', 1, { [link]: 5 })), true);
  // 单纯往来结算/补录可由账本作废：后端会同步恢复往来余额。
  assert.equal(model.isLinkedEntry(entry(1, 'settlement', 1, { party_id: 5 })), false);
});
