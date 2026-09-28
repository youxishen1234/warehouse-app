const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('atomic transactions reject negative extended business fields and roll back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-invariant-fields-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [], orders: [], stocktakes: [], delivery_notes: [] }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir };
const script = `const db=require('./db'); const p=db.addProduct({name:'扩展字段商品',stock:0,price:2}); const cases=[['order',()=>{const row=db.addOrder({order_no:'INV-FIELDS-1',quantity:1,unit_price:2}); row.amount=-1; return row.id;}],['ledger',()=>{const row=db.addLedger({type:'income',amount:2}); row.amount=-1; return row.id;}],['note',()=>{const note=db.addDeliveryNote({date:'2026-09-28',freight:0,lines:[{product_id:p.id,quantity:1,delivered_qty:0,unit_price:2}]}); note.lines[0].amount=-1; return note.id;}]]; for(const [kind,action] of cases){ const before=JSON.stringify(db.backupData()); const key='negative-'+kind; try { db.transact({id:'inv-'+kind},key,key+'-fp',String(db.revision()),'extended invariant',()=>({id:action()})); process.exit(2); } catch(e) { if(!/无效/.test(e.message)) process.exit(3); } if(JSON.stringify(db.backupData())!==before || db.receipt('inv-'+kind,key)!==null) process.exit(4); } process.stdout.write('ok');`;
  try { assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' }), 'ok'); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
