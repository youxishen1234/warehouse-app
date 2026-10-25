const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const exportsObject = {};
const source = fs.readFileSync('src/pages/business-center/daily-records.ts', 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: exportsObject, Date });
const { dailyRecords, localDay, partyMonthSummary } = exportsObject;
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

test('customer-billed production receipts show the customer on each daily row and link to its own ledger entry', () => {
  const data = blank();
  data.transactions = [
    { id: 10, type: 'in', billing_source: 'production_inbound', customer_id: 7, customer_name: '示例客户', product_name: '礼盒箱', specification: '30×20×15 cm', quantity: 10, unit: '个', amount: 300, created_at: now },
    { id: 11, type: 'in', billing_source: 'production_inbound', customer_id: 7, customer_name: '示例客户', product_name: '礼盒箱', specification: '30×20×15 cm', quantity: 8, unit: '个', amount: 200, created_at: now - 1000 }
  ];
  data.ledger = [
    { id: 70, type: 'receivable', transaction_id: 10, party_type: 'customer', party_id: 7, amount: 300, created_at: now },
    { id: 71, type: 'receivable', transaction_id: 11, party_type: 'customer', party_id: 7, amount: 200, created_at: now - 1000 }
  ];

  const rows = dailyRecords(data, localDay(now));
  assert.equal(rows.length, 2);
  assert.equal(Array.from(rows, row => row.title).join('|'), '示例客户 · 入库单|示例客户 · 入库单');
  assert.equal(Array.from(rows, row => row.detail).join('|'), '30×20×15 cm|30×20×15 cm');
  assert.equal(Array.from(rows, row => row.value).join('|'), '300|200');
  assert.equal(Array.from(rows, row => row.target.ledger).join('|'), '70|71');
});

test('supplier receipts keep supplier names and unassociated receipts keep product fallback', () => {
  const data = blank();
  data.transactions = [
    { id: 20, type: 'in', supplier_id: 8, supplier_name: '纸板供应商', product_name: '瓦楞纸板', specification: '160×110 cm', quantity: 100, unit: '张', amount: 500, created_at: now },
    { id: 21, type: 'in', supplier_name: '', customer_name: '', product_name: '库存纸箱', specification: '40×30×20 cm', quantity: 12, unit: '个', created_at: now - 1000 }
  ];

  const rows = dailyRecords(data, localDay(now));
  assert.equal(rows.find(row => row.id === 'transaction-20').title, '纸板供应商 · 入库单');
  assert.equal(rows.find(row => row.id === 'transaction-21').title, '库存纸箱 · 入库单');
  assert.equal(rows.find(row => row.id === 'transaction-21').target.records, true);
});

test('party month summary separates billing, settlements and voided rows', () => {
  const current = new Date(2026, 9, 19, 12).getTime();
  const previous = new Date(2026, 8, 30, 23, 59).getTime();
  const ledger = [
    { id: 1, type: 'receivable', party_type: 'customer', party_id: 7, amount: 120.5, created_at: current },
    { id: 2, type: 'receivable', party_type: 'customer', party_id: 7, amount: 30, created_at: current },
    { id: 3, type: 'settlement', party_type: 'customer', party_id: 7, amount: 50, created_at: current },
    { id: 4, type: 'receivable', party_type: 'customer', party_id: 7, amount: 999, created_at: previous },
    { id: 5, type: 'receivable', party_type: 'customer', party_id: 7, amount: 500, created_at: current, voided_at: current },
    { id: 6, type: 'payable', party_type: 'supplier', party_id: 7, amount: 80, created_at: current },
    { id: 7, type: 'settlement', party_type: 'supplier', party_id: 7, amount: 20, created_at: current }
  ];
  const customers = partyMonthSummary(ledger, false, new Date(current));
  const suppliers = partyMonthSummary(ledger, true, new Date(current));
  assert.equal(customers.get(7).monthSales, 150.5);
  assert.equal(customers.get(7).monthSettled, 50);
  assert.equal(suppliers.get(7).monthSales, 80);
  assert.equal(suppliers.get(7).monthSettled, 20);
  assert.equal(customers.has(99), false);
});

test('month summary ignores legacy rows whose party type contradicts the ledger type', () => {
  const current = new Date(2026, 9, 19, 12).getTime();
  const rows = partyMonthSummary([
    { id: 1, type: 'settlement', party_type: 'supplier', party_id: 3, amount: 40, created_at: current },
    { id: 2, type: 'payable', party_id: 4, amount: 25, created_at: current }
  ], false, new Date(current));
  assert.equal(rows.size, 0);
});
