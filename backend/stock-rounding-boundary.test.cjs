const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('stock out compares and persists inventory at six-decimal precision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-stock-rounding-boundary-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir };
  const script = `const db=require('./db'); const p=db.addProduct({name:'六位边界',stock:0.30000000000000004,price:1,unit:'件'}); const posted=db.stockOut(p.id,0.3,'test'); if(posted.transaction.quantity!==0.3 || db.getProduct(p.id).stock!==0) process.exit(2); try { db.stockOut(p.id,0.000001,'test'); process.exit(3); } catch(e) { if(!/库存不足/.test(e.message)) process.exit(4); } process.stdout.write('ok');`;
  try {
    assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' }), 'ok');
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(saved.products[0].stock, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
