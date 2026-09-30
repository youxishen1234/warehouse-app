const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
test('paperboard batches persist with atomic quantities, billing, replay and backup validation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-test-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('./db'); const app = express(); app.use(express.json()); app.use('/api', require('./team')(db));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port + '/api'; let seq = 0;
  const call = async (url, method = 'GET', body, key = 'paperboard-test-' + String(++seq).padStart(8, '0'), revision = db.revision()) => { const r = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'If-Match': String(revision), 'X-Warehouse-Device': 'board-test' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  const form = { supplier: '真实测试板厂', boardLength: 165, boardWidth: 115, cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B', layers: 3, faceGsm: 150, linerGsm: 150, flutingGsm: 120, orderedQty: 1000, receivedQty: 1004, billedArea: 1897.5, unitPrice: 2.1, date: '2026-09-01', warningQty: 200, location: 'A区' };
  try {
    let batch;
    await t.test('actual receipt and billed area stay independent; same request cannot create twice', async () => {
      const r = await call('/boards', 'POST', form, 'board-replay-test-001'); assert.equal(r.status, 200, r.message); batch = r.data;
      assert.equal(batch.remainingQty, 1004); assert.equal(batch.giftQty, 4); assert.equal(batch.amount, 3984.75);
      const again = await call('/boards', 'POST', form, 'board-replay-test-001', 0); assert.equal(again.data.id, batch.id); assert.equal(db.listBoards().length, 1);
      const second = await call('/boards', 'POST', { ...form, supplier: '第二板厂', receivedQty: 900 }); assert.notEqual(second.data.id, batch.id); assert.equal(second.data.shortageQty, 100); assert.equal(second.data.specKey, batch.specKey);
    });
    await t.test('invalid quantities never alter disk, revision or batches', async () => {
      for (const value of [-1, 0, 1.5, 'NaN', null, true, '']) { const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'); const r = await call('/boards', 'POST', { ...form, receivedQty: value }); assert.equal(r.status, 400, JSON.stringify(r)); assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before); }
      for (const extra of [{ date: '2026-02-30' }, { supplier: '' }, { billedArea: -1 }, { boardWidth: 0 }, { cartonHeight: '' }]) assert.equal((await call('/boards', 'POST', { ...form, ...extra })).status, 400);
    });
    await t.test('batch-specific deduction, replay and overdraft protection', async () => {
      const out = { type: 'out', quantity: 500, recipient: '', remark: '生产' };
      const r = await call('/boards/' + batch.id + '/movements', 'POST', out, 'board-out-replay-001'); assert.equal(r.status, 200, r.message); assert.equal(r.data.remainingQty, 504);
      assert.equal((await call('/boards/' + batch.id + '/movements', 'POST', out, 'board-out-replay-001', 0)).data.remainingQty, 504);
      const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'); assert.equal((await call('/boards/' + batch.id + '/movements', 'POST', { ...out, quantity: 505 })).status, 400); assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
      assert.equal(db.listBoards().find(b => b.id !== batch.id).remainingQty, 900);
      assert.equal((await call('/boards/' + batch.id + '/movements', 'POST', out, undefined, 0)).status, 409);
    });
    await t.test('count adjustment keeps audit trail and survives reload', async () => {
      const result = await call('/boards/' + batch.id + '/movements', 'POST', { type: 'count', quantity: 500, remark: '清点少4张' }); assert.equal(result.status, 200, result.message); assert.equal(result.data.movements[0].quantity, -4);
      const backup = db.backupData(); require('./boards').validate(backup);
      const corrupt = structuredClone(backup); corrupt.board_batches[0].remainingQty++; assert.throws(() => db.restoreData(corrupt), /纸板/);
      db.restoreData(backup); delete require.cache[require.resolve('./db')]; const reloaded = require('./db'); assert.equal(reloaded.listBoards().find(b => b.id === batch.id).remainingQty, 500);
      assert.equal((await call('/boards/' + batch.id)).data.movements.length, 3);
      assert.equal((await call('/boards/unknown')).status, 404);
    });
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
