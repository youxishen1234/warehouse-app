const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

test('inventory value equals the sum of rounded active product values', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-stats-precision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'data.json');
  const products = [
    { id: 1, name: 'fraction-a', stock: 0.1, price: 0.05, safety_stock: 0, unit: 'unit' },
    { id: 2, name: 'fraction-b', stock: 0.1, price: 0.05, safety_stock: 1, unit: 'unit' },
    { id: 3, name: 'disabled', stock: 100, price: 10, safety_stock: 200, unit: 'unit', deleted_at: 1 },
    { id: 4, name: 'zero', stock: 0, price: 10, safety_stock: 0, unit: 'unit' }
  ];
  fs.writeFileSync(dataFile, JSON.stringify({ products, customers: [], suppliers: [], transactions: [], ledger: [] }));
  const output = execFileSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./db').stats()))"], {
    cwd: __dirname,
    env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: path.join(dir, 'backups') },
    encoding: 'utf8'
  });
  const stats = JSON.parse(output);
  assert.equal(stats.totalValue, 0.02, 'each 0.005 product value rounds to 0.01 before summation');
  assert.equal(stats.totalStock, 0.2);
  assert.equal(stats.totalStockByUnit.unit, 0.2);
  assert.equal(stats.lowStock, 2, 'zero safety warns only when stock is exactly zero; disabled products are excluded');
  assert.equal(stats.totalProducts, 3);
});

test('stats keeps inactive party balances in receivable/payable totals', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-party-stats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'data.json');
  const now = Date.now();
  fs.writeFileSync(dataFile, JSON.stringify({ products: [],
    customers: [{ id: 1, name: '停用客户', debt: 12.34, deleted_at: now }],
    suppliers: [{ id: 1, name: '停用供应商', payable: 5.67, deleted_at: now }],
    transactions: [], ledger: [] }));
  const output = execFileSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./db').stats()))"], {
    cwd: __dirname,
    env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: path.join(dir, 'backups') },
    encoding: 'utf8'
  });
  const stats = JSON.parse(output);
  assert.equal(stats.totalCustomers, 0);
  assert.equal(stats.totalSuppliers, 0);
  assert.equal(stats.totalReceivable, 12.34);
  assert.equal(stats.totalPayable, 5.67);
});
