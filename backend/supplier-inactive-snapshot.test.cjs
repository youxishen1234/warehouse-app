const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('product supplier snapshot remains after supplier deactivation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-supplier-inactive-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir };
  const script = `const db=require('./db'); const supplier=db.addSupplier({name:'停用供应商快照'}); const product=db.addProduct({name:'关联商品',stock:0,price:2,supplier_id:supplier.id}); db.deleteSupplier(supplier.id); const current=db.getProduct(product.id); if(current.supplier_id!==supplier.id || current.supplier_name!=='停用供应商快照' || !db.backupData().suppliers[0].deleted_at) process.exit(2); process.stdout.write('ok');`;
  try { assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' }), 'ok'); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
