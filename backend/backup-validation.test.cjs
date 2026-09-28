const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('invalid backup is rejected before replacing current data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backup-validation-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [{ id: 1, name: 'valid', stock: 3, price: 2, safety_stock: 0, unit: '件' }],
    customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const script = `const db=require('./db'); const before=JSON.stringify(db.backupData()); const bad=JSON.parse(before); bad.products[0].stock=-1; try { db.restoreData(bad); process.exit(2); } catch (e) { if (!/非负数/.test(e.message)) process.exit(3); } if (JSON.stringify(db.backupData()) !== before) process.exit(4);`;
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir } });
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(saved.products[0].stock, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup restore rejects negative stocktake quantities without replacing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backup-stocktake-validation-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [{ id: 1, name: 'valid', stock: 3, price: 2, safety_stock: 0, unit: '件' }],
    customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [],
    stocktakes: [], delivery_notes: []
  }));
  const script = `const db=require('./db'); const before=JSON.stringify(db.backupData()); const bad=JSON.parse(before); bad.stocktakes=[{id:1,product_id:1,before_stock:3,counted_stock:-0.1,diff:-3.1,created_at:Date.now(),counted_at:Date.now()}]; try { db.restoreData(bad); process.exit(2); } catch (e) { if (!/非负数/.test(e.message)) process.exit(3); } if (JSON.stringify(db.backupData()) !== before) process.exit(4);`;
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir } });
    assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).products[0].stock, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup restore rejects stocktake transactions without their generated ledger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backup-adjustment-ledger-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [{ id: 1, name: 'valid', stock: 3, price: 2, safety_stock: 0, unit: '件' }],
    customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const script = `const db=require('./db'); const before=JSON.stringify(db.backupData()); const bad=JSON.parse(before); bad.products[0].stock=4; bad.stocktakes=[{id:1,product_id:1,product_name:'valid',before_stock:3,counted_stock:4,diff:1,created_at:Date.now(),counted_at:Date.now()}]; bad.transactions=[{id:1,product_id:1,product_name:'valid',type:'adjustment',quantity:1,unit_price:2,amount:2,adjustment:1,stocktake_id:1,created_at:Date.now()}]; try { db.restoreData(bad); process.exit(2); } catch (e) { if (!/盘点流水.*账本流水不一致/.test(e.message)) process.exit(3); } if (JSON.stringify(db.backupData()) !== before) process.exit(4);`;
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir } });
    assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).products[0].stock, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup restore rejects adjustment transactions without a stocktake reference', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backup-adjustment-reference-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [{ id: 1, name: 'valid', stock: 4, price: 2, safety_stock: 0, unit: '件' }],
    customers: [], suppliers: [], transactions: [], ledger: [{ id: 1, type: 'income', amount: 2, transaction_id: 1, created_at: Date.now() }], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const script = `const db=require('./db'); const before=JSON.stringify(db.backupData()); const bad=JSON.parse(before); bad.transactions=[{id:1,product_id:1,product_name:'valid',type:'adjustment',quantity:1,unit_price:2,amount:2,adjustment:1,created_at:Date.now()}]; try { db.restoreData(bad); process.exit(2); } catch (e) { if (!/盘点流水.*盘点记录/.test(e.message)) process.exit(3); } if (JSON.stringify(db.backupData()) !== before) process.exit(4);`;
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir } });
    assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).products[0].stock, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup restore rejects adjustment transactions that disagree with stocktake diff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backup-adjustment-mismatch-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [{ id: 1, name: 'valid', stock: 4, price: 2, safety_stock: 0, unit: '件' }],
    customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const script = `const db=require('./db'); const before=JSON.stringify(db.backupData()); const bad=JSON.parse(before); bad.products[0].stock=4; bad.stocktakes=[{id:1,product_id:1,product_name:'valid',before_stock:3,counted_stock:4,diff:1,created_at:Date.now(),counted_at:Date.now()}]; bad.transactions=[{id:1,product_id:1,product_name:'valid',type:'adjustment',quantity:2,unit_price:2,amount:4,adjustment:2,stocktake_id:1,created_at:Date.now()}]; bad.ledger=[{id:1,type:'income',amount:4,transaction_id:1,created_at:Date.now()}]; try { db.restoreData(bad); process.exit(2); } catch (e) { if (!/盘点流水.*盘点记录不一致/.test(e.message)) process.exit(3); } if (JSON.stringify(db.backupData()) !== before) process.exit(4);`;
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir } });
    assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).products[0].stock, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup restore preserves zero-difference stocktakes without a zero ledger entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backup-zero-stocktake-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [{ id: 1, name: 'valid', stock: 4, price: 2, safety_stock: 0, unit: '件' }],
    customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const script = `const db=require('./db'); const p=db.getProduct(1); db.addStocktake({product_id:1,counted_stock:4}); const backup=db.backupData(); db.restoreData(backup); if (db.listStocktakes({product_id:1}).length !== 1 || db.listLedger({include_voided:'true'}).length !== 0) process.exit(2);`;
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup restore rejects a delivery line linked to another valid receipt transaction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backup-delivery-link-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const script = `const db=require('./db'); const a=db.addProduct({name:'A',stock:0,price:2}); const b=db.addProduct({name:'B',stock:0,price:2}); const date=new Date(); const businessDate=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0'); const noteA=db.addDeliveryNote({date:businessDate,lines:[{product_id:a.id,quantity:1,delivered_qty:1,unit_price:2}]}); const noteB=db.addDeliveryNote({date:businessDate,lines:[{product_id:b.id,quantity:1,delivered_qty:1,unit_price:2}]}); const before=JSON.stringify(db.backupData()); const bad=JSON.parse(before); bad.delivery_notes.find(note=>note.id===noteA.id).lines[0].transaction_id=noteB.lines[0].transaction_id; try { db.restoreData(bad); process.exit(2); } catch (e) { if (!/送货单.*明细与入库流水不一致/.test(e.message)) process.exit(3); } if (JSON.stringify(db.backupData()) !== before) process.exit(4);`;
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir } });
    assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).transactions.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup restore rejects delivery freight without its matching expense ledger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backup-freight-ledger-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const script = `const db=require('./db'); const p=db.addProduct({name:'运费商品',stock:0,price:2}); const now=new Date(); const date=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0'); const note=db.addDeliveryNote({date,freight:5,lines:[{product_id:p.id,quantity:1,delivered_qty:1,unit_price:2}]}); const before=JSON.stringify(db.backupData()); const bad=JSON.parse(before); bad.ledger=bad.ledger.filter(entry=>entry.delivery_note_id !== note.id); try { db.restoreData(bad); process.exit(2); } catch (e) { if (!/送货单.*运费与账本流水不一致/.test(e.message)) process.exit(3); } if (JSON.stringify(db.backupData()) !== before) process.exit(4);`;
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir } });
    assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).ledger.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup restore rejects money fields with fractions smaller than one cent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backup-money-precision-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [{ id: 1, name: '金额精度商品', stock: 1, price: 1, safety_stock: 0, unit: '件' }],
    customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const script = `const db=require('./db'); const before=JSON.stringify(db.backupData()); const bad=JSON.parse(before); bad.ledger=[{id:1,type:'income',amount:1.001,created_at:Date.now()}]; try { db.restoreData(bad); process.exit(2); } catch (e) { if (!/账本金额必须精确到分/.test(e.message)) process.exit(3); } if (JSON.stringify(db.backupData()) !== before) process.exit(4);`;
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir } });
    assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).ledger.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup restore rejects a party-linked stock transaction missing its ledger row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backup-stock-ledger-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const script = `const db=require('./db'); const p=db.addProduct({name:'应收商品',stock:2,price:3}); const c=db.addCustomer({name:'客户',debt:0}); db.stockOut(p.id,1,'','',c.id); const before=JSON.stringify(db.backupData()); const bad=JSON.parse(before); bad.ledger=[]; try { db.restoreData(bad); process.exit(2); } catch (e) { if (!/交易.*与账本流水不一致/.test(e.message)) process.exit(3); } if (JSON.stringify(db.backupData()) !== before) process.exit(4);`;
  try {
    execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir } });
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(saved.ledger.length, 1);
    assert.equal(saved.customers[0].debt, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
