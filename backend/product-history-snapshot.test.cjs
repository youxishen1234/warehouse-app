const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('product price and specification edits do not rewrite transaction snapshots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-product-snapshot-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir };
  const script = `const db=require('./db'); const p=db.addProduct({name:'历史快照',stock:0,price:2.5,specification:'旧规格'}); const posted=db.stockIn(p.id,2,'test','',null,{unit_price:2.5}); db.updateProduct(p.id,{price:9.9,specification:'新规格'}); const tx=db.listTx({product_id:p.id}).find(row=>row.id===posted.transaction.id); if(tx.unit_price!==2.5 || tx.amount!==5 || tx.specification!=='旧规格' || db.getProduct(p.id).price!==9.9 || db.getProduct(p.id).specification!=='新规格') process.exit(2); process.stdout.write('ok');`;
  try { assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' }), 'ok'); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
