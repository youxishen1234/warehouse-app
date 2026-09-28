const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('system-generated receivable ledger rolls back with a failed stock transaction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-system-ledger-atomic-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir };
  const script = `const db=require('./db'); const p=db.addProduct({name:'原子账本商品',stock:2,price:3}); const c=db.addCustomer({name:'原子账本客户'}); const before=JSON.stringify(db.backupData()); const key='system-ledger-atomic'; try { db.transact({id:9201,username:'admin'},key,'system-ledger-fingerprint',String(db.revision()),'system ledger atomic test',()=>{ db.stockOut(p.id,1,'test','',c.id); db.getProduct(p.id).stock=2; return {id:p.id}; }); process.exit(2); } catch(e) { if(!/库存与出入库流水不一致/.test(e.message)) process.exit(3); } if(JSON.stringify(db.backupData())!==before || db.receipt(9201,key)!==null) process.exit(4); process.stdout.write('ok');`;
  try {
    assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' }), 'ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
