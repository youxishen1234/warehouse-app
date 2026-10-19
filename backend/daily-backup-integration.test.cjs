const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

test('server daily backup privately downloads and restores business data and original images', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-daily-integration-'));
  const keys = ['WAREHOUSE_DATA_FILE', 'WAREHOUSE_BACKUP_DIR', 'WAREHOUSE_DAILY_BACKUP_DIR', 'WAREHOUSE_PRODUCT_IMAGE_DIR'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'source.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(dir, 'backups');
  process.env.WAREHOUSE_DAILY_BACKUP_DIR = path.join(dir, 'daily');
  process.env.WAREHOUSE_PRODUCT_IMAGE_DIR = path.join(dir, 'product-images');
  const empty = { products: [], customers: [], suppliers: [], transactions: [], ledger: [] };
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify(empty));
  const db = require('./db');
  const { createDailyBackup } = require('./daily-backup');
  const service = createDailyBackup(db, { now: () => Date.parse('2026-10-19T03:00:00+08:00') });
  const express = require('express'); const app = express();
  app.use(express.json({ limit: '5mb' })); app.use('/api', require('./team')(db, { dailyBackup: service }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let token = '';
  const call = async (url, method = 'GET', body, authenticated = true) => {
    const r = await fetch(origin + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  try {
    assert.equal((await call('/backup/daily/status', 'GET', undefined, false)).status, 401);
    assert.equal((await call('/backup/daily/latest', 'GET', undefined, false)).status, 401);
    token = (await call('/auth/guest', 'POST', {})).body.data.token;
    const initial = (await call('/backup/daily/status')).body.data;
    assert.equal(initial.active, false); assert.equal(initial.verified, false); assert.equal(initial.lastSuccessAt, null);
    assert.equal((await call('/backup/daily/latest')).status, 404);

    const batch = db.receiveBoard({ supplier: '每日备份供货商', boardLength: 160, boardWidth: 110, cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B', layers: 3, orderedQty: 100, receivedQty: 100, billedArea: 176, unitPrice: 1, date: '2026-10-01' });
    const production = db.completeProduction({ batch_id: batch.id, product_name: '备份纸箱', consumed_quantity: 10, quantity: 8 }, 'test');
    const customer = db.addCustomer({ name: '每日备份客户' });
    db.updateProduct(production.product_id, { price: 3 });
    db.stockOut(production.product_id, 2, 'test', '', customer.id);
    const entry = db.listLedger().find(row => row.transaction_id && row.party_type === 'customer');
    const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFz8AAAAASUVORK5CYII=', 'base64');
    const sha = crypto.createHash('sha256').update(original).digest('hex');
    const filename = production.product_id + '-' + sha.slice(0, 24) + '.png';
    fs.mkdirSync(process.env.WAREHOUSE_PRODUCT_IMAGE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.WAREHOUSE_PRODUCT_IMAGE_DIR, filename), original);
    db.updateProduct(production.product_id, { image_url: '/uploads/products/' + filename });
    const photo = db.addLedgerAttachment(entry.id, db.prepareLedgerAttachment({ kind: 'signed', client_id: 'daily-original-image-001', name: '客户签收单.png', data: 'data:image/png;base64,' + original.toString('base64') }));
    const dimensions = db.getCustomerDimensions(); dimensions.customers.push({ id: 'daily-customer', name: customer.name, specs: [{ id: 'daily-spec', goods: '备份纸箱', size: '400×300×200', sizeUnit: 'mm', material: 'B', unit: '个', kind: '成品' }] }); db.updateCustomerDimensions(dimensions);
    const before = db.backupData();
    service.start(); await service.runDue();
    const status = await call('/backup/daily/status');
    assert.equal(status.status, 200); assert.equal(status.body.data.active, true); assert.equal(status.body.data.verified, true);
    assert.equal(status.body.data.lastSuccessAt, '2026-10-18T19:00:00.000Z'); assert.equal(status.headers.get('cache-control'), 'no-store');
    assert(!JSON.stringify(status.body).includes(dir));
    const download = await call('/backup/daily/latest'); assert.equal(download.status, 200);
    const saved = download.body.data; db.validateBackup(saved.data);
    for (const name of ['products', 'customers', 'suppliers', 'transactions', 'ledger', 'board_batches', 'production_records', 'customer_dimensions']) assert.deepEqual(saved.data[name], before[name], name);
    assert.equal(saved.data.ledger_attachment_files[photo.sha256], 'data:image/png;base64,' + original.toString('base64'));
    assert.equal(saved.data.product_image_files[filename].data, original.toString('base64'));
    assert.deepEqual(db.backupData(), before, 'backup is read-only business state');

    const bundle = path.join(dir, 'download.json'), restored = path.join(dir, 'restored.json'), restoredImages = path.join(dir, 'restored-images');
    fs.writeFileSync(bundle, JSON.stringify(saved)); fs.writeFileSync(restored, JSON.stringify(empty));
    const script = "const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),db=require('./db');const bundle=JSON.parse(fs.readFileSync(process.env.TEST_BUNDLE,'utf8'));db.restoreData(bundle.data);const value=db.backupData();for(const key of ['products','customers','suppliers','transactions','ledger','board_batches','production_records'])assert.deepEqual(value[key],bundle.data[key],key);assert.deepEqual(value.customer_dimensions.customers,bundle.data.customer_dimensions.customers);for(const [name,image] of Object.entries(bundle.data.product_image_files))assert.equal(fs.readFileSync(path.join(process.env.WAREHOUSE_PRODUCT_IMAGE_DIR,name)).toString('base64'),image.data);for(const row of value.ledger)for(const a of row.attachments||[])assert.equal(db.readLedgerAttachment(row.id,a.id).data,bundle.data.ledger_attachment_files[a.sha256]);assert.equal(value.product_image_files,undefined);assert.equal(value.ledger_attachment_files,undefined);process.stdout.write('restored');";
    assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: restored, WAREHOUSE_BACKUP_DIR: path.join(dir, 'restored-backups'), WAREHOUSE_PRODUCT_IMAGE_DIR: restoredImages, TEST_BUNDLE: bundle }, encoding: 'utf8' }), 'restored');
    await service.stop(); assert.equal((await call('/backup/daily/status')).body.data.active, false);
  } finally {
    await service.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

test('production startServer starts daily scheduling and close stops it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-daily-lifecycle-'));
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  try {
    const script = "(async()=>{const assert=require('node:assert/strict'),app=require('./server');const server=app.startServer();await new Promise(r=>server.once('listening',r));await app.dailyBackup.runDue();const s=await app.dailyBackup.getStatus();assert.equal(s.active,true);assert.equal(s.verified,true);server.closeAllConnections();await new Promise(r=>server.close(r));assert.equal(app.dailyBackup.status().active,false);process.stdout.write('lifecycle-ok');})().catch(e=>{console.error(e);process.exitCode=1;});";
    const output = execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, PORT: '0', WAREHOUSE_DATA_FILE: path.join(dir, 'data.json'), WAREHOUSE_BACKUP_DIR: path.join(dir, 'backups'), WAREHOUSE_DAILY_BACKUP_DIR: path.join(dir, 'daily'), WAREHOUSE_PRODUCT_IMAGE_DIR: path.join(dir, 'images'), WAREHOUSE_DAILY_BACKUP_ENABLED: 'true' }, encoding: 'utf8', timeout: 15000 });
    assert.match(output, /lifecycle-ok/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
