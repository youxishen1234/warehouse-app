const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { createDailyBackup } = require('./daily-backup');
const now = Date.parse('2026-10-20T04:00:00Z');
const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFz8AAAAASUVORK5CYII=', 'base64');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const empty = () => ({ products: [], customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: [] });
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backup-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeSnapshot(root, day, corrupt = false) {
  const data = { ...empty(), _collaboration: { revision: 3 } };
  const payload = { format: 'warehouse-daily-v1', scheduledDay: day, exportedAt: `${day}T04:00:00.000Z`, revision: 3, data, sha256: corrupt ? '0'.repeat(64) : hash(JSON.stringify(data)) };
  fs.writeFileSync(path.join(root, `daily-${day}.json.gz`), zlib.gzipSync(JSON.stringify(payload)));
}
function service(root) {
  const db = { revision: () => 3, backupData: () => ({ ...empty(), _collaboration: { revision: 3 } }), validateBackup: data => assert.ok(Array.isArray(data.products)) };
  return createDailyBackup(db, { directory: root, maxBytes: 65536, env: {}, now: () => now, logger: { error() {}, warn() {} } });
}
function run(root, source, script, extra = {}) {
  fs.writeFileSync(path.join(root, 'data.json'), typeof source === 'string' ? source : JSON.stringify(source));
  return execFileSync(process.execPath, ['-e', script], { cwd: __dirname, encoding: 'utf8', timeout: 15000, env: { ...process.env, WAREHOUSE_DATA_FILE: path.join(root, 'data.json'), WAREHOUSE_BACKUP_DIR: path.join(root, 'backups'), WAREHOUSE_PRODUCT_IMAGE_DIR: path.join(root, 'images'), ...extra } });
}
test('verification-only errors disappear after the corrupt file is repaired', async t => {
  const root = directory(t); writeSnapshot(root, '2026-10-19'); writeSnapshot(root, '2026-10-20', true);
  const daily = service(root);
  const broken = await daily.getStatus();
  assert.equal(broken.verified, true); assert.notEqual(broken.lastError, null);
  assert.equal(broken.lastSuccessAt, '2026-10-19T04:00:00.000Z');
  writeSnapshot(root, '2026-10-20');
  const repaired = await daily.getStatus();
  assert.equal(repaired.verified, true); assert.equal(repaired.lastError, null);
  assert.equal(repaired.lastSuccessAt, '2026-10-20T04:00:00.000Z');
});
test('repeated and concurrent status/download requests retain a complete valid backup result', async t => {
  const root = directory(t), daily = service(root); await daily.runDue();
  const before = fs.readFileSync(path.join(root, 'daily-2026-10-20.json.gz'));
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => index % 2 ? daily.getStatus() : daily.latest()));
  for (let index = 0; index < results.length; index++) {
    if (index % 2) { assert.equal(results[index].verified, true); assert.equal(results[index].lastError, null); }
    else assert.equal(results[index].exportedAt, '2026-10-20T04:00:00.000Z');
  }
  assert.deepEqual(fs.readFileSync(path.join(root, 'daily-2026-10-20.json.gz')), before);
});
test('an earlier status directory scan cannot roll back the latest finalized daily result', async t => {
  const root = directory(t), daily = service(root); writeSnapshot(root, '2026-10-19');
  const readdir = fs.promises.readdir;
  let signalCaptured, releaseCaptured, hold = true;
  const captured = new Promise(resolve => { signalCaptured = resolve; });
  const released = new Promise(resolve => { releaseCaptured = resolve; });
  try {
    fs.promises.readdir = async (target, ...args) => {
      const names = await readdir.call(fs.promises, target, ...args);
      if (target === root && hold) { hold = false; signalCaptured(); await released; }
      return names;
    };
    const pendingStatus = daily.getStatus();
    await captured;
    assert.equal(await daily.runDue(), true);
    assert.equal(daily.status().lastSuccessAt, '2026-10-20T04:00:00.000Z');
    releaseCaptured();
    const result = await pendingStatus;
    assert.equal(result.lastSuccessAt, '2026-10-20T04:00:00.000Z', 'older in-flight status scan must not replace the newly completed snapshot');
    assert.equal(daily.status().lastSuccessAt, '2026-10-20T04:00:00.000Z');
  } finally { releaseCaptured(); fs.promises.readdir = readdir; }
});
test('restore-guard publication failure leaves database bytes and business cache unchanged', t => {
  const root = directory(t);
  const output = run(root, empty(), `const fs=require('fs'),assert=require('node:assert/strict'),db=require('./db');db.addProduct({name:'guard-original',stock:2,price:3});const before=JSON.stringify(db.backupData()),disk=fs.readFileSync(process.env.WAREHOUSE_DATA_FILE,'utf8');const incoming=JSON.parse(before);incoming.products[0].name='incoming';const link=fs.linkSync;fs.linkSync=(a,b)=>{if(String(b).endsWith('-restore-guard.json'))throw Object.assign(Error('forced EIO'),{code:'EIO'});return link(a,b);};assert.throws(()=>db.restoreData(incoming),/恢复前无法备份当前数据/);assert.equal(JSON.stringify(db.backupData()),before);assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE,'utf8'),disk);assert.equal(fs.readdirSync(process.env.WAREHOUSE_BACKUP_DIR).some(n=>n.includes('.tmp-')),false);process.stdout.write('guard-atomic');`);
  assert.equal(output, 'guard-atomic');
});
test('structurally corrupt but JSON-parsable database is preserved as raw startup evidence', t => {
  const root = directory(t), raw = JSON.stringify({ ...empty(), products: { unexpected: true } });
  assert.throws(() => run(root, raw, `require('./db')`, {}));
  const names = fs.readdirSync(path.join(root, 'backups')).filter(name => name.endsWith('-startup.json'));
  assert.equal(names.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'backups', names[0]), 'utf8'), raw);
  assert.equal(fs.readFileSync(path.join(root, 'data.json'), 'utf8'), raw);
});
test('restore destination-image conflict does not mutate current business or collaboration state', t => {
  const root = directory(t);
  const sha = hash(original), filename = `1-${sha.slice(0, 24)}.png`;
  fs.mkdirSync(path.join(root, 'images')); fs.writeFileSync(path.join(root, 'images', filename), Buffer.from('existing conflicting image'));
  const output = run(root, empty(), `const fs=require('fs'),assert=require('node:assert/strict'),db=require('./db');const actor={id:'review',username:'review'};db.transact(actor,'review-product-key-001','product',String(db.revision()),'review create',()=>db.addProduct({name:'current',stock:2,price:3}));const before=JSON.stringify(db.backupData()),disk=fs.readFileSync(process.env.WAREHOUSE_DATA_FILE,'utf8');const incoming=JSON.parse(before);incoming.products[0].image_url='/uploads/products/${filename}';incoming.product_image_files={'${filename}':{mime:'image/png',size:${original.length},sha256:'${sha}',data:'${original.toString('base64')}'}};assert.throws(()=>db.restoreData(incoming),/现有同名商品图片不同/);assert.equal(JSON.stringify(db.backupData()),before);assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE,'utf8'),disk);process.stdout.write('conflict-atomic');`);
  assert.equal(output, 'conflict-atomic');
});
