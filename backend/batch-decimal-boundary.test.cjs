const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('batch decimal outbound leaves no negative or ghost inventory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-batch-decimal-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir };
  const script = `const db=require('./db'); const a=db.addProduct({name:'小数A',stock:0.000001,price:1}); const b=db.addProduct({name:'小数B',stock:0.000002,price:1}); const result=db.stockOutBatch([{product_id:a.id,quantity:0.000001,unit_price:1},{product_id:b.id,quantity:0.000002,unit_price:1}]); if(result.length!==2 || db.getProduct(a.id).stock!==0 || db.getProduct(b.id).stock!==0) process.exit(2); if(db.getProduct(a.id).stock<0 || db.getProduct(b.id).stock<0) process.exit(3); try { db.stockOutBatch([{product_id:a.id,quantity:0.000001,unit_price:1}]); process.exit(4); } catch(e) { if(!/库存不足/.test(e.message)) process.exit(5); } process.stdout.write('ok');`;
  try {
    assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' }), 'ok');
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(saved.products.every(product => product.stock >= 0), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
