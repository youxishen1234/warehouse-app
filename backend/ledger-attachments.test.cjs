const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

test('ledger evidence persists original photos, retries safely, and travels with backups', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-ledger-photos-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(dir, 'backups');
  const empty = { products: [], customers: [], suppliers: [], transactions: [], ledger: [] };
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify(empty));
  const db = require('./db');
  const app = require('./server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const customer = db.addCustomer({ name: '凭证隔离测试客户' });
  const product = db.addProduct({ name: '凭证隔离测试纸箱', stock: 30, price: 2 });
  db.stockOut(product.id, 5, 'test', '', customer.id);
  const entry = db.listLedger()[0];
  const other = db.addLedger({ type: 'income', amount: 7, remark: '隔离测试' });
  const original = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFz8AAAAASUVORK5CYII=', 'base64'), Buffer.from('original evidence metadata - preserve bytes')]);
  const dataUrl = `data:image/png;base64,${original.toString('base64')}`;
  const guest = async () => (await (await fetch(`${origin}/api/auth/guest`, { method: 'POST' })).json()).data.token;
  let token = await guest();
  let counter = 0;
  const call = async (url, body, options = {}) => {
    const response = await fetch(`${origin}/api${url}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': `ledger-photos-test-${++counter}`, 'If-Match': String(db.revision()), ...options.headers },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json() };
  };
  const upload = { kind: 'signed', client_id: 'photo-client-id-original', name: '签收单正面.png', data: dataUrl };
  let meta; let exported;
  const financial = () => {
    const snapshot = db.backupData();
    return JSON.stringify({ products: snapshot.products, customers: snapshot.customers, suppliers: snapshot.suppliers, transactions: snapshot.transactions, ledger: snapshot.ledger.map(({ attachments, ...row }) => row) });
  };
  try {
    await t.test('original bytes and stable business linkage survive reload without changing money or inventory', async () => {
      const before = financial();
      const result = await call(`/ledger/${entry.id}/attachments`, upload);
      assert.equal(result.status, 200);
      meta = result.data.data;
      assert.equal(meta.ledger_id, entry.id);
      assert.equal(meta.source.party_id, customer.id);
      assert.equal(meta.source.transaction_id, entry.transaction_id);
      assert.equal(meta.status, 'unreviewed');
      assert.equal(meta.sha256, crypto.createHash('sha256').update(original).digest('hex'));
      assert.equal(financial(), before);
      assert.equal(JSON.parse(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8')).ledger[0].attachments[0].id, meta.id);
      const content = await call(`/ledger/${entry.id}/attachments/${meta.id}/content`);
      assert.equal(content.data.data.data, dataUrl);
      const list = await call('/ledger');
      assert.equal(JSON.stringify(list).includes('base64'), false, 'ordinary ledger responses contain metadata only');
    });

    await t.test('idempotency replay, new sessions and repeated file selection do not duplicate evidence', async () => {
      const headers = { 'Idempotency-Key': 'ledger-photos-fixed-key', 'If-Match': String(db.revision()) };
      const first = await call(`/ledger/${entry.id}/attachments`, upload, { headers });
      const replay = await call(`/ledger/${entry.id}/attachments`, upload, { headers });
      assert.equal(first.data.data.id, meta.id);
      assert.equal(replay.data.data.id, meta.id);
      token = await guest();
      const selectedAgain = await call(`/ledger/${entry.id}/attachments`, { ...upload, client_id: 'photo-client-id-selected-again' });
      assert.equal(selectedAgain.data.data.id, meta.id);
      assert.equal(db.getLedgerAttachments(entry.id).length, 1);
      const different = await call(`/ledger/${entry.id}/attachments`, { ...upload, kind: 'payment' });
      assert.equal(different.status, 400, 'a client ID cannot silently change the evidence type');
    });

    await t.test('content requires the existing session and correct parent ledger ID', async () => {
      assert.equal((await call(`/ledger/${entry.id}/attachments/${meta.id}/content`, undefined, { headers: { Authorization: '' } })).status, 401);
      assert.equal((await call(`/ledger/${other.id}/attachments/${meta.id}/content`)).status, 404);
      assert.equal((await call('/backup', undefined, { headers: { Authorization: 'Bearer expired' } })).status, 401);
      assert.notEqual((await fetch(`${origin}/uploads/ledger/${meta.sha256}`)).status, 200);
    });

    await t.test('invalid formats, stale writes and large originals are rejected without creating metadata', async () => {
      assert.equal((await call(`/ledger/${entry.id}/attachments`, { ...upload, data: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
      assert.equal((await call(`/ledger/${entry.id}/attachments`, { ...upload, data: 'data:image/jpeg;base64,YWJjZA==' })).status, 400);
      assert.equal((await call(`/ledger/${entry.id}/attachments`, { ...upload, kind: 'other' })).status, 400);
      assert.equal((await call(`/ledger/${entry.id}/attachments`, upload, { headers: { 'If-Match': '-1' } })).status, 409);
      const bytes = Buffer.alloc(12 * 1024 * 1024 + 1); original.copy(bytes);
      assert.equal((await call(`/ledger/${entry.id}/attachments`, { ...upload, data: `data:image/png;base64,${bytes.toString('base64')}` })).status, 400);
      assert.equal((await call(`/ledger/${entry.id}/attachments`, { ...upload, data: 'x'.repeat(17 * 1024 * 1024) })).status, 413);
      assert.equal(db.getLedgerAttachments(entry.id).length, 1);
    });

    await t.test('failed database transactions do not expose an uploaded attachment', () => {
      const before = JSON.stringify(db.backupData());
      assert.throws(() => db.transact({ id: 'atomic-photo', username: 'test' }, 'atomic-photo-key-001', 'fingerprint', String(db.revision()), 'test photo rollback', () => {
        db.addLedgerAttachment(other.id, db.prepareLedgerAttachment({ ...upload, client_id: 'photo-client-atomic-id' }));
        throw new Error('forced rollback');
      }), /forced rollback/);
      assert.equal(JSON.stringify(db.backupData()), before);
      assert.deepEqual(db.getLedgerAttachments(other.id), []);
    });

    await t.test('export includes originals and checksums; corrupt and incomplete imports are atomic', async () => {
      exported = (await call('/backup')).data.data.data;
      assert.equal(exported.ledger_attachment_files[meta.sha256], dataUrl);
      assert.equal(db.backupData().ledger_attachment_files, undefined, 'internal snapshots remain lightweight');
      assert.throws(() => db.backupData({ includeAttachments: true, maxBytes: 100 }), /备份大小限制/);
      const before = JSON.stringify(db.backupData());
      for (const damage of [value => { delete value.ledger_attachment_files; }, value => { value.ledger_attachment_files[meta.sha256] = dataUrl.slice(0, -4) + 'AAAA'; }, value => { value.ledger[0].attachments[0].ledger_id = other.id; }]) {
        const bad = structuredClone(exported); damage(bad);
        assert.equal((await call('/backup', { data: bad })).status, 400);
        assert.equal(JSON.stringify(db.backupData()), before);
      }
    });

    await t.test('portable and automatic backups restore photos on a different data path', () => {
      const target = path.join(dir, 'restored.json');
      const bundle = path.join(dir, 'bundle.json');
      fs.writeFileSync(target, JSON.stringify(empty));
      fs.writeFileSync(bundle, JSON.stringify(exported));
      const script = `const fs=require('fs');const db=require('./db');const snapshot=JSON.parse(fs.readFileSync(process.env.PHOTO_BUNDLE,'utf8'));db.restoreData(snapshot);const item=db.getLedgerAttachments(${entry.id})[0];if(db.readLedgerAttachment(${entry.id},item.id).data!==snapshot.ledger_attachment_files[item.sha256])throw new Error('bytes mismatch');process.stdout.write(item.id);`;
      const env = { ...process.env, WAREHOUSE_DATA_FILE: target, WAREHOUSE_BACKUP_DIR: path.join(dir, 'restored-backups'), PHOTO_BUNDLE: bundle };
      assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' }), meta.id);
      execFileSync(process.execPath, ['-e', "require('./db')"], { cwd: __dirname, env, encoding: 'utf8' });
      const auto = fs.readdirSync(env.WAREHOUSE_BACKUP_DIR).map(name => JSON.parse(fs.readFileSync(path.join(env.WAREHOUSE_BACKUP_DIR, name), 'utf8'))).find(value => value.ledger_attachment_files);
      assert.ok(auto);
      assert.equal(auto.ledger_attachment_files[meta.sha256], dataUrl);
    });

    await t.test('voiding does not erase retained evidence; adding to a voided ledger is blocked', async () => {
      const added = await call(`/ledger/${other.id}/attachments`, { ...upload, client_id: 'void-retain-photo-client' });
      const id = added.data.data.id;
      db.deleteLedger(other.id);
      assert.equal((await call(`/ledger/${other.id}/attachments/${id}/content`)).status, 200);
      assert.equal((await call(`/ledger/${other.id}/attachments`, { ...upload, client_id: 'void-new-photo-client-id' })).status, 400);
    });

    await t.test('the photo count limit preserves earlier attachments and still permits duplicate retries', async () => {
      for (let index = 1; index < 20; index++) {
        const bytes = Buffer.concat([original, Buffer.from(String(index))]);
        const result = await call(`/ledger/${entry.id}/attachments`, { ...upload, client_id: `max-photo-count-client-${index}`, data: `data:image/png;base64,${bytes.toString('base64')}` });
        assert.equal(result.status, 200);
      }
      const overflow = await call(`/ledger/${entry.id}/attachments`, { ...upload, client_id: 'max-photo-count-overflow', kind: 'delivery' });
      assert.equal(overflow.status, 400);
      assert.equal(db.getLedgerAttachments(entry.id).length, 20);
      assert.equal((await call(`/ledger/${entry.id}/attachments`, upload)).data.data.id, meta.id);
    });

    await t.test('damaged originals fail closed without disclosing a private filesystem path', async () => {
      const filename = path.join(`${process.env.WAREHOUSE_DATA_FILE}.attachments`, meta.sha256);
      fs.writeFileSync(filename, Buffer.from('damaged'));
      const result = await call(`/ledger/${entry.id}/attachments/${meta.id}/content`);
      assert.equal(result.status, 500);
      assert.equal(JSON.stringify(result).includes(dir), false);
      fs.writeFileSync(filename, original);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
