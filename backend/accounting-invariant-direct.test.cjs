const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('party balance changes without matching ledger roll back atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-party-invariant-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir };
  const script = `const db=require('./db');
const customer=db.addCustomer({name:'应收回滚客户'});
const supplier=db.addSupplier({name:'应付回滚供应商'});
const before=JSON.stringify(db.backupData());
  for (const item of [{id:9101, row:() => db.getCustomer(customer.id), field:'debt', label:'customer'}, {id:9102, row:() => db.getSupplier(supplier.id), field:'payable', label:'supplier'}]) {
  const key='party-invariant-'+item.id;
  try { db.transact({id:item.id, username:'admin'}, key, key+'-fingerprint', String(db.revision()), 'party invariant test', () => { const row = item.row(); row[item.field]=1; return {id:row.id}; }); process.exit(2); }
  catch (error) { if (!new RegExp('往来余额与账本不一致：'+item.label).test(error.message)) process.exit(3); }
  if (JSON.stringify(db.backupData()) !== before || db.receipt(item.id, key) !== null) process.exit(4);
}
process.stdout.write('ok');`;
  try {
    const output = execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' });
    assert.equal(output, 'ok');
    assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')).customers[0].debt, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')).suppliers[0].payable, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
