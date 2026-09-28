const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('product and stocktake writes persist six-decimal stock precision across restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-stock-precision-'));
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, JSON.stringify({
    _meta: { schemaVersion: 1 }, products: [], customers: [], suppliers: [],
    transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: file, WAREHOUSE_BACKUP_DIR: path.join(dir, 'backups') };
  try {
    execFileSync(process.execPath, ['-e', `const db=require('./db'); const p=db.addProduct({name:'precision', stock:0.30000000000000004, price:1, unit:'?'}); db.addStocktake({product_id:p.id, counted_stock:0.6000000000000001});`], { cwd: __dirname, env });
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.products[0].stock, 0.6);
    assert.equal(persisted.stocktakes[0].before_stock, 0.3);
    assert.equal(persisted.stocktakes[0].counted_stock, 0.6);
    assert.equal(persisted.stocktakes[0].diff, 0.3);
    assert.equal(persisted.transactions[0].quantity, 0.3);
    const check = execFileSync(process.execPath, ['-e', `const db=require('./db'); process.stdout.write(JSON.stringify({stock:db.getProduct(1).stock, tx:db.listTx()[0].quantity}));`], { cwd: __dirname, env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(check), { stock: 0.6, tx: 0.3 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup restore also clears sub-micro ghost stock before persisting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-restore-ghost-'));
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, JSON.stringify({
    _meta: { schemaVersion: 1 }, products: [{ id: 1, name: 'ghost', stock: 0, price: 1, safety_stock: 0, unit: '件' }], customers: [], suppliers: [],
    transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: file, WAREHOUSE_BACKUP_DIR: path.join(dir, 'backups') };
  try {
    const output = execFileSync(process.execPath, ['-e', "const db=require('./db'); const backup=db.backupData(); backup.products[0].stock=0.0000001; db.restoreData(backup); process.stdout.write(JSON.stringify({stock:db.getProduct(1).stock,updated:db.getProduct(1).stock_updated_at > 0}));"], { cwd: __dirname, env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), { stock: 0, updated: true });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).products[0].stock, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
