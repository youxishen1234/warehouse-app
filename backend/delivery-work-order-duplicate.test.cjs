const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('duplicate work orders require explicit confirmation and preserve atomicity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-work-order-duplicate-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [], delivery_notes: [] }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir };
  const script = `const db=require('./db'); const p=db.addProduct({name:'重复工单商品',stock:0,price:2}); const base={date:'2026-09-28',work_order_no:'WO-REPEAT-001',lines:[{product_id:p.id,quantity:1,delivered_qty:1,unit_price:2}]}; const first=db.addDeliveryNote(base); const before=JSON.stringify(db.backupData()); try { db.addDeliveryNote(base); process.exit(2); } catch(e) { if(!/已有未作废送货单，请确认/.test(e.message)) process.exit(3); } if(JSON.stringify(db.backupData())!==before) process.exit(4); const confirmed=db.addDeliveryNote({...base,confirm_duplicate_work_order:true}); if(confirmed.work_order_no!==base.work_order_no || db.listDeliveryNotes().length!==2) process.exit(5); process.stdout.write('ok');`;
  try { assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' }), 'ok'); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
