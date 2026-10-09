const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { empty } = require('./customer-dimensions');

test('customer dimensions migrate, commit, back up and restore with the warehouse', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-dimensions-backup-'));
  const dataFile = path.join(directory, 'data.json');
  const legacyFile = path.join(directory, 'dimensions.json');
  process.env.WAREHOUSE_DATA_FILE = dataFile;
  process.env.WAREHOUSE_DIMENSIONS_FILE = legacyFile;
  process.env.WAREHOUSE_BACKUP_MAX_MB = '8';
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const legacy = { ...empty(), revision: 7, customers: [{ id: 'company-1', name: '迁移客户', specs: [{ id: 'spec-1', goods: '', size: '40x30x20', sizeUnit: 'cm', material: '', unit: '个', kind: '成品' }] }] };
  delete legacy.schemaVersion;
  fs.writeFileSync(legacyFile, JSON.stringify(legacy));
  const db = require('./db');
  const app = require('./server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, extra = {}) => {
    const response = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json', 'X-Warehouse-Device': 'dimensions-regression', 'Idempotency-Key': crypto.randomUUID(), 'If-Match': String(db.revision()), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), revision: response.headers.get('x-warehouse-revision') };
  };
  const disk = () => fs.readFileSync(dataFile, 'utf8');
  let exported;
  await t.test('legacy file is imported once and retained unchanged', () => {
    assert.equal(db.getCustomerDimensions().revision, 7);
    assert.equal(db.getCustomerDimensions().customers[0].name, '迁移客户');
    assert.equal(JSON.parse(disk()).customer_dimensions.customers[0].name, '迁移客户');
    assert.deepEqual(JSON.parse(fs.readFileSync(legacyFile, 'utf8')), legacy);
    fs.writeFileSync(legacyFile, 'invalid legacy file after migration');
    const reopened = JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./db").getCustomerDimensions()))'], { cwd: __dirname, env: process.env, encoding: 'utf8' }));
    assert.deepEqual(reopened, db.getCustomerDimensions());
  });
  await t.test('dimension saves update the global revision and replay the same request', async () => {
    const draft = db.getCustomerDimensions();
    draft.customers[0].name = '备份客户';
    const headers = { 'Idempotency-Key': crypto.randomUUID() };
    const first = await call('/customer-dimensions', 'PUT', draft, headers);
    assert.equal(first.status, 200);
    assert.equal(first.body.data.revision, 8);
    assert.equal(first.revision, '1');
    const again = await call('/customer-dimensions', 'PUT', draft, headers);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.data, first.body.data);
    assert.equal(db.revision(), 1);
    assert.equal((await call('/customer-dimensions', 'PUT', draft)).status, 409);
    exported = (await call('/backup')).body.data.data;
    assert.equal(exported.customer_dimensions.customers[0].name, '备份客户');
    assert.equal(exported.customer_dimensions.schemaVersion, 1);
  });
  await t.test('failed persistence rolls back dimensions, revision, audit and receipt', async () => {
    const before = disk();
    const revision = db.revision();
    const draft = db.getCustomerDimensions(); draft.theme.title = '不能提交';
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => { if (target === dataFile) throw new Error('simulated persistence failure'); return rename(source, target); };
    try { assert.equal((await call('/customer-dimensions', 'PUT', draft)).status, 500); }
    finally { fs.renameSync = rename; }
    assert.equal(disk(), before);
    assert.equal(db.revision(), revision);
    assert.equal(db.getCustomerDimensions().theme.title, exported.customer_dimensions.theme.title);
  });
  await t.test('restoring dimensions invalidates old editors and old backups preserve dimensions', async () => {
    const changed = db.getCustomerDimensions(); changed.customers[0].name = '恢复前';
    assert.equal((await call('/customer-dimensions', 'PUT', changed)).status, 200);
    const staleEditor = db.getCustomerDimensions();
    assert.equal((await call('/backup', 'POST', { data: exported })).status, 200);
    assert.equal(db.getCustomerDimensions().customers[0].name, '备份客户');
    assert.ok(db.getCustomerDimensions().revision > staleEditor.revision);
    assert.equal((await call('/customer-dimensions', 'PUT', staleEditor)).status, 409);
    const oldBackup = db.backupData(); delete oldBackup.customer_dimensions;
    assert.equal((await call('/backup', 'POST', { data: oldBackup })).status, 200);
    assert.equal(db.getCustomerDimensions().customers[0].name, '备份客户');
  });
  await t.test('malformed dimension backups cannot replace any business data', async () => {
    const before = disk();
    const bad = db.backupData(); bad.customer_dimensions.customers[0].specs = [null];
    assert.equal((await call('/backup', 'POST', { data: bad })).status, 400);
    assert.equal(disk(), before);
  });
  await t.test('restores a real collection above 5 MiB and retains a configured body ceiling', async () => {
    const backup = db.backupData();
    backup.products = Array.from({ length: 12000 }, (_, i) => ({ id: i + 1, name: '商品' + i, stock: 0, price: 0, safety_stock: 0, specification: 'S'.repeat(100), material: 'M'.repeat(100), remark: 'R'.repeat(300) }));
    const bytes = Buffer.byteLength(JSON.stringify({ data: backup }));
    assert.ok(bytes > 5 * 1024 * 1024 && bytes < 8 * 1024 * 1024);
    const restored = await call('/backup', 'POST', { data: backup });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(db.listProducts().length, 12000);
    assert.equal(db.getCustomerDimensions().customers[0].name, '备份客户');
    const revision = db.revision();
    assert.equal((await call('/backup', 'POST', { padding: 'X'.repeat(8 * 1024 * 1024) })).status, 413);
    assert.equal(db.revision(), revision);
  });
});
