const { test } = require('node:test');
const assert = require('node:assert/strict');
const { numberValue, lineAmount, dimensions, QUANTITY_DECIMALS, MONEY_DECIMALS, AREA_DECIMALS, MAX_QUANTITY_VALUE, MAX_MONEY_VALUE } = require('./stock-math');
test('numeric precision policy is declared once and shared by validation', () => {
  assert.equal(QUANTITY_DECIMALS, 6);
  assert.equal(MONEY_DECIMALS, 2);
  assert.equal(AREA_DECIMALS, 4);
  assert.equal(MAX_QUANTITY_VALUE, Number.MAX_SAFE_INTEGER / 1e6);
  assert.equal(MAX_MONEY_VALUE, Number.MAX_SAFE_INTEGER / 1e2);
});
test('numeric limits reject overflow explicitly', () => {
  assert.throws(() => numberValue('10000000000000', '数量'), /数值过大/);
  assert.throws(() => lineAmount(Number.MAX_SAFE_INTEGER, 100), /金额超出支持范围/);
});
test('specification dimensions accept multiplication signs and explicit dimensions', () => {
  for (const separator of ['×', 'x', 'X', '*']) assert.deepEqual(dimensions(`1,000 ${separator} 500/B`), [1000, 500]);
  assert.deepEqual(dimensions('1000×500/B', { length: 200, width: 300 }), [200, 300]);
  assert.deepEqual(dimensions('invalid'), [0, 0]);
});
test('startup normalizes ghost stock without changing meaningful decimals', () => {
  const path = require('node:path'); const os = require('node:os'); const fs = require('node:fs');
  const dbPath = path.join(os.tmpdir(), `warehouse-ghost-${Date.now()}-${Math.random()}.json`);
  process.env.WAREHOUSE_DATA_FILE = dbPath;
  fs.writeFileSync(dbPath, JSON.stringify({ _meta: { schemaVersion: 1 }, products: [
    { id: 1, name: 'ghost', stock: 0.0000001, price: 1, unit: '件', safety_stock: 0, deleted_at: null },
    { id: 2, name: 'decimal', stock: 0.000001, price: 1, unit: '件', safety_stock: 0, deleted_at: null }
  ], customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: [], receipts: {}, audit: [], revision: 0 }));
  const db = require('./db'); const products = db.listProducts();
  assert.equal(products.find(product => product.id === 1).stock, 0);
  assert.equal(products.find(product => product.id === 2).stock, 0.000001);
  fs.rmSync(dbPath, { force: true });
});

test('stats totalStock uses the same six-decimal precision as unit totals', () => {
  const path = require('node:path'); const os = require('node:os'); const fs = require('node:fs');
  const dbPath = path.join(os.tmpdir(), `warehouse-total-stock-${Date.now()}-${Math.random()}.json`);
  process.env.WAREHOUSE_DATA_FILE = dbPath;
  fs.writeFileSync(dbPath, JSON.stringify({ _meta: { schemaVersion: 1 }, products: [
    { id: 1, name: 'a', stock: 0.1, safety_stock: 0, price: 1, unit: '件', deleted_at: null },
    { id: 2, name: 'b', stock: 0.2, safety_stock: 0, price: 1, unit: '件', deleted_at: null }
  ], customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: [], receipts: {}, audit: [], revision: 0 }));
  const child = require('node:child_process').execFileSync(process.execPath, ['-e', "const db=require('./db'); process.stdout.write(JSON.stringify(db.stats()))"], { cwd: path.join(__dirname) }).toString();
  const stats = JSON.parse(child); assert.equal(stats.totalStock, 0.3); assert.equal(stats.totalStockByUnit['件'], 0.3);
  fs.rmSync(dbPath, { force: true });
});
