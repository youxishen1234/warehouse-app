const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const model = {};
const source = fs.readFileSync('src/components/FinanceCenter/model.ts', 'utf8');
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText, { exports: model });

const note = (id, customerId, date, amount, extra = {}) => ({
  id, date, customer_id: customerId, source_type: 'production', total_amount: amount,
  created_at: Date.parse('2026-10-23T12:00:00+08:00'), lines: [], ...extra
});

const ledgerEntry = (id, type, amount, partyId, month, day, extra = {}) => ({
  id, type, amount, party_id: partyId, remark: '', created_at: new Date(2026, month - 1, day, 12).getTime(), ...extra
});

test('customer bill rows and totals follow selected period while balance remains global', () => {
  const entries = [
    ledgerEntry(1, 'receivable', 300, 7, 10, 1),
    ledgerEntry(2, 'settlement', 80, 7, 10, 2, { party_type: 'customer' }),
    ledgerEntry(3, 'receivable', 200, 7, 9, 30, { party_type: 'customer' }),
    ledgerEntry(4, 'settlement', 999, 7, 10, 3, { party_type: 'supplier' }),
    ledgerEntry(5, 'settlement', 500, 7, 10, 4, { party_type: 'customer', voided_at: Date.now() }),
    ledgerEntry(6, 'receivable', 50, 8, 10, 4, { party_type: 'customer' })
  ];
  const current = model.filterPartyLedgerEntries(entries, 'customer', 7, '2026-10-01', '2026-10-31');
  assert.deepEqual(Array.from(current, row => row.id), [1, 2]);
  assert.deepEqual(JSON.parse(JSON.stringify(model.summarizePartyLedger(current, 'customer'))), { sales: 300, settled: 80 });
  const previous = model.filterPartyLedgerEntries(entries, 'customer', 7, '2026-09-01', '2026-09-30');
  assert.deepEqual(Array.from(previous, row => row.id), [3]);
  assert.deepEqual(JSON.parse(JSON.stringify(model.summarizePartyLedger(previous, 'customer'))), { sales: 200, settled: 0 });
  assert.equal(model.filterPartyLedgerEntries(entries, 'customer', 7).length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(model.summarizePartyLedger(model.filterPartyLedgerEntries(entries, 'customer', 7), 'customer'))), { sales: 500, settled: 80 });
});

test('supplier bill rows and totals follow selected period with supplier fallback', () => {
  const entries = [
    ledgerEntry(1, 'payable', 420, 9, 10, 1, { party_type: 'supplier' }),
    ledgerEntry(2, 'settlement', 120, 9, 10, 2, { party_type: 'supplier' }),
    ledgerEntry(3, 'payable', 180, 9, 9, 30),
    ledgerEntry(4, 'settlement', 900, 9, 10, 3, { party_type: 'customer' }),
    ledgerEntry(5, 'payable', 600, 9, 10, 4, { party_type: 'supplier', voided_at: Date.now() })
  ];
  const current = model.filterPartyLedgerEntries(entries, 'supplier', 9, '2026-10-01', '2026-10-31');
  assert.deepEqual(Array.from(current, row => row.id), [1, 2]);
  assert.deepEqual(JSON.parse(JSON.stringify(model.summarizePartyLedger(current, 'supplier'))), { sales: 420, settled: 120 });
  const previous = model.filterPartyLedgerEntries(entries, 'supplier', 9, '2026-09-01', '2026-09-30');
  assert.deepEqual(Array.from(previous, row => row.id), [3]);
  assert.deepEqual(JSON.parse(JSON.stringify(model.summarizePartyLedger(previous, 'supplier'))), { sales: 180, settled: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(model.summarizePartyLedger(model.filterPartyLedgerEntries(entries, 'supplier', 9), 'supplier'))), { sales: 600, settled: 120 });
});

test('party period labels distinguish monthly views from cumulative totals', () => {
  assert.equal(model.partyPeriodLabel('本月'), '本月');
  assert.equal(model.partyPeriodLabel('上月'), '上月');
  assert.equal(model.partyPeriodLabel('全部时间'), '累计');
});

test('customer production inbound shows each valid note and totals 300 + 200 without voids', () => {
  const notes = [
    note(10, 7, '2026-10-01', 300),
    note(11, 7, '2026-10-22', 200),
    note(12, 7, '2026-10-23', 999, { voided_at: Date.now() }),
    note(13, 8, '2026-10-23', 500),
    note(14, null, '2026-10-23', 700),
    note(15, 7, '2026-10-23', 400, { source_type: undefined, party_type: 'supplier' })
  ];
  const summary = model.summarizeProductionInbound(notes, 7);
  assert.equal(summary.count, 2);
  assert.equal(summary.total, 500);
  assert.deepEqual(Array.from(summary.notes, row => row.id), [11, 10]);
});

test('production inbound date filtering uses the delivery note date rather than creation time', () => {
  const notes = [
    note(1, 3, '2026-09-30', 50, { created_at: Date.parse('2026-10-01T00:01:00') }),
    note(2, 3, '2026-10-01', 80, { created_at: Date.parse('2026-09-29T00:01:00') }),
    note(3, 3, '2026-10-31', 20)
  ];
  const summary = model.summarizeProductionInbound(notes, 3, '2026-10-01', '2026-10-31');
  assert.equal(summary.count, 2);
  assert.equal(summary.total, 100);
});

test('production inbound totals round to cents and safely fall back to line amounts', () => {
  const direct = note(1, 2, '2026-10-01', 1.005);
  assert.equal(model.productionNoteAmount(direct), 1.01);
  const fallback = note(2, 2, '2026-10-01', undefined, { lines: [{ amount: 2.1 }, { amount: 3.2 }] });
  assert.equal(model.productionNoteAmount(fallback), 5.3);
});
