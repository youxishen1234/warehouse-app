const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('today statistics use the server local timezone zero point', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-stats-timezone-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const script = `const db=require('./db'); const now=new Date(); const today=new Date(now.getFullYear(),now.getMonth(),now.getDate(),20,0,0,0); const previous=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1,23,59,0,0); const data=db.backupData(); data.products=[{id:1,name:'时区商品',stock:2,price:1,safety_stock:0,unit:'件'}]; data.transactions=[{id:1,product_id:1,product_name:'时区商品',type:'in',quantity:1,unit_price:1,amount:1,created_at:today.getTime()},{id:2,product_id:1,product_name:'时区商品',type:'in',quantity:1,unit_price:1,amount:1,created_at:previous.getTime()}]; data._meta.nextProductId=2; data._meta.nextTransactionId=3; db.restoreData(data); const stats=db.stats(); if(stats.todayIn!==1) process.exit(2); process.stdout.write(JSON.stringify({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,todayIn:stats.todayIn}));`;
  try {
    const output = execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, TZ: 'Asia/Singapore', WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir }, encoding: 'utf8' });
    assert.match(output, /"todayIn":1/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
