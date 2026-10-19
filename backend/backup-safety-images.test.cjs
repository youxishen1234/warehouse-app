const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFz8AAAAASUVORK5CYII=', 'base64');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const emptyDatabase = () => ({ products: [], customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: [] });
function run(root, name, script, extra = {}) {
  return execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
    env: {
      ...process.env,
      WAREHOUSE_DATA_FILE: path.join(root, `${name}.json`),
      WAREHOUSE_BACKUP_DIR: path.join(root, `${name}-backups`),
      WAREHOUSE_PRODUCT_IMAGE_DIR: path.join(root, `${name}-images`),
      ...extra
    }
  });
}
test('startup and restore guard save complete portable originals', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-safety-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataFile = path.join(root, 'source.json'), backupDir = path.join(root, 'source-backups'), imageDir = path.join(root, 'source-images');
  const sha = digest(image), filename = `1-${sha.slice(0, 24)}.png`;
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(path.join(imageDir, filename), image);
  fs.writeFileSync(dataFile, JSON.stringify({
    ...emptyDatabase(),
    products: [{ id: 1, name: '原图商品', stock: 1, price: 2, safety_stock: 0, unit: '件', image_url: `/uploads/products/${filename}` }]
  }));
  const seed = `const db=require('./db');const customer=db.addCustomer({name:'原图客户'});db.stockOut(1,1,'test','',customer.id);const entry=db.listLedger().find(row=>row.party_type==='customer');db.addLedgerAttachment(entry.id,db.prepareLedgerAttachment({kind:'signed',client_id:'safety-original-photo-001',name:'签收原图.png',data:'data:image/png;base64,${image.toString('base64')}'}));process.stdout.write('seeded');`;
  assert.equal(run(root, 'source', seed), 'seeded');
  const customerSeed = `const db=require('./db');const customer=db.addCustomer({name:'客户送货单照片'});db.addCustomerAttachment(customer.id,db.prepareCustomerAttachment({kind:'delivery',client_id:'safety-customer-photo-001',name:'客户送货单.png',data:'data:image/png;base64,${image.toString('base64')}'}));process.stdout.write('seeded');`;
  assert.equal(run(root, 'source', customerSeed), 'seeded');
  const script = "const db=require('./db');db.restoreData(db.backupData({includeAttachments:true}));process.stdout.write('ok');";
  assert.equal(run(root, 'source', script), 'ok');
  const names = fs.readdirSync(backupDir).filter(name => name.endsWith('.json'));
  assert.ok(names.some(name => name.endsWith('-startup.json')));
  assert.ok(names.some(name => name.endsWith('-restore-guard.json')));
  const withEvidence = [];
  for (const name of names) {
    const bundle = JSON.parse(fs.readFileSync(path.join(backupDir, name), 'utf8'));
    assert.equal(bundle.product_image_files[filename].data, image.toString('base64'), name);
    assert.equal(bundle.product_image_files[filename].sha256, sha, name);
    if (bundle.ledger.some(row => row.attachments?.length)) {
      assert.equal(bundle.ledger_attachment_files[sha], `data:image/png;base64,${image.toString('base64')}`, name);
      withEvidence.push(name);
    }
    if (bundle.customers.some(row => row.customer_attachments?.length)) {
      assert.equal(bundle.ledger_attachment_files[sha], `data:image/png;base64,${image.toString('base64')}`, name);
      withEvidence.push(name);
    }
  }
  assert.ok(withEvidence.some(name => name.endsWith('-startup.json')));
  assert.ok(withEvidence.some(name => name.endsWith('-restore-guard.json')));
  const verify = "const db=require('./db');const snapshot=db.backupData({includeAttachments:true});const customer=snapshot.customers.find(row=>row.customer_attachments?.length);const photo=customer.customer_attachments[0];if(db.readCustomerAttachment(customer.id,photo.id).data!==snapshot.ledger_attachment_files[photo.sha256])throw Error('客户照片原图不一致');process.stdout.write('verified');";
  assert.equal(run(root, 'source', verify), 'verified');
});
test('missing originals block automatic backup and restore before business data changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-safety-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = `1-${'a'.repeat(24)}.png`;
  fs.writeFileSync(path.join(root, 'source.json'), JSON.stringify({
    ...emptyDatabase(),
    products: [{ id: 1, name: '缺图商品', stock: 1, price: 2, safety_stock: 0, unit: '件', image_url: `/uploads/products/${filename}` }]
  }));
  const before = fs.readFileSync(path.join(root, 'source.json'), 'utf8');
  const script = "const assert=require('node:assert/strict'),db=require('./db');const before=JSON.stringify(db.backupData());assert.throws(()=>db.restoreData(JSON.parse(before)),/备份当前数据/);assert.equal(JSON.stringify(db.backupData()),before);process.stdout.write('blocked');";
  assert.equal(run(root, 'source', script), 'blocked');
  assert.equal(fs.readFileSync(path.join(root, 'source.json'), 'utf8'), before);
  const evidence = fs.readdirSync(path.join(root, 'source-backups')).filter(name => name.endsWith('-restore-guard.json'));
  assert.equal(evidence.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'source-backups', evidence[0]), 'utf8')).product_image_files, undefined);
});
test('failed guard publication preserves business data and removes partial files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-safety-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataFile = path.join(root, 'source.json');
  fs.writeFileSync(dataFile, JSON.stringify(emptyDatabase()));
  const before = fs.readFileSync(dataFile, 'utf8');
  const script = "const assert=require('node:assert/strict'),fs=require('node:fs'),db=require('./db');const before=JSON.stringify(db.backupData()),link=fs.linkSync;fs.linkSync=()=>{throw Object.assign(new Error('simulated disk failure'),{code:'EIO'});};try{assert.throws(()=>db.restoreData(JSON.parse(before)),/备份当前数据/);assert.equal(JSON.stringify(db.backupData()),before);}finally{fs.linkSync=link;}process.stdout.write('blocked');";
  assert.equal(run(root, 'source', script), 'blocked');
  assert.equal(fs.readFileSync(dataFile, 'utf8'), before);
  const names = fs.readdirSync(path.join(root, 'source-backups'));
  assert.equal(names.some(name => name.includes('restore-guard') || name.includes('.tmp-')), false);
});
test('corrupt databases remain preserved as raw startup evidence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-safety-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const raw = '{broken database';
  fs.writeFileSync(path.join(root, 'source.json'), raw);
  assert.throws(() => run(root, 'source', "require('./db')"));
  const evidence = fs.readdirSync(path.join(root, 'source-backups')).filter(name => name.endsWith('-startup.json'));
  assert.equal(evidence.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'source-backups', evidence[0]), 'utf8'), raw);
});
