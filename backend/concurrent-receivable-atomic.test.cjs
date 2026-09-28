const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('concurrent stock outs accept one revision and create one receivable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-concurrent-receivable-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir };
  const script = `const db=require('./db'); const p=db.addProduct({name:'并发应收商品',stock:5,price:2}); const c=db.addCustomer({name:'并发应收客户'}); const revision=String(db.revision()); const body=()=>db.transact({id:'actor-'+Math.random()},'concurrent-key-'+Math.random(),'fingerprint-'+Math.random(),revision,'concurrent stock out',()=>({transactions:db.stockOutBatch([{product_id:p.id,quantity:4,unit_price:2}],'test','',c.id)})); const result=[]; for(const actor of [1,2]) { try { result.push({status:200,data:body()}); } catch(e) { result.push({status:e.status||500,message:e.message}); } } if(result.map(item=>item.status).sort().join(',')!=='200,409') process.exit(2); if(db.getProduct(p.id).stock!==1 || db.getCustomer(c.id).debt!==8 || db.listLedger({type:'receivable'}).filter(entry=>entry.party_id===c.id).length!==1) process.exit(3); process.stdout.write('ok');`;
  try { assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' }), 'ok'); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
