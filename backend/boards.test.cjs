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
  const form = { supplier: '真实测试板厂', customerName: '晨光包装', material: '牛卡 / 高强瓦楞', printPlate: '客户正面版', printColor: '红 + 黑', boardLength: 165, boardWidth: 115, cartonLength: 40, cartonWidth: 30, cartonHeight: 20, fluteType: 'B', layers: 3, faceGsm: 150, linerGsm: 150, flutingGsm: 120, orderedQty: 1000, receivedQty: 1004, billedArea: 1897.5, unitPrice: 2.1, date: '2026-09-01', warningQty: 200, location: 'A区' };
  try {
    let batch;
    await t.test('actual receipt and billed area stay independent; same request cannot create twice', async () => {
      const r = await call('/boards', 'POST', form, 'board-replay-test-001'); assert.equal(r.status, 200, r.message); batch = r.data;
      assert.equal(batch.remainingQty, 1004); assert.equal(batch.giftQty, 4); assert.equal(batch.amount, 3984.75);
      assert.equal(batch.customerName, '晨光包装'); assert.equal(batch.material, '牛卡 / 高强瓦楞'); assert.equal(batch.printPlate, '客户正面版'); assert.equal(batch.printColor, '红 + 黑');
      const again = await call('/boards', 'POST', form, 'board-replay-test-001', 0); assert.equal(again.data.id, batch.id); assert.equal(db.listBoards().length, 1);
      const second = await call('/boards', 'POST', { ...form, supplier: '第二板厂', receivedQty: 900 }); assert.notEqual(second.data.id, batch.id); assert.equal(second.data.shortageQty, 100); assert.equal(second.data.specKey, batch.specKey);
    });
    await t.test('invalid quantities never alter disk, revision or batches', async () => {
      for (const value of [-1, 0, 1.5, 'NaN', null, true, '']) { const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'); const r = await call('/boards', 'POST', { ...form, receivedQty: value }); assert.equal(r.status, 400, JSON.stringify(r)); assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before); }
      for (const extra of [{ date: '2026-02-30' }, { billedArea: -1 }, { boardWidth: 0 }, { cartonHeight: '' }]) assert.equal((await call('/boards', 'POST', { ...form, ...extra })).status, 400);
      for (const extra of [{ customerName: '客户\u0001名' }, { material: '配纸'.repeat(61) }, { printPlate: 123 }, { printColor: '颜色\u007f' }]) assert.equal((await call('/boards', 'POST', { ...form, ...extra })).status, 400);
    });
    await t.test('batch-specific deduction, replay and overdraft protection', async () => {
      const out = { type: 'out', quantity: 500, recipient: '', remark: '生产' };
      const r = await call('/boards/' + batch.id + '/movements', 'POST', out, 'board-out-replay-001'); assert.equal(r.status, 200, r.message); assert.equal(r.data.remainingQty, 504);
      assert.equal((await call('/boards/' + batch.id + '/movements', 'POST', out, 'board-out-replay-001', 0)).data.remainingQty, 504);
      const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'); assert.equal((await call('/boards/' + batch.id + '/movements', 'POST', { ...out, quantity: 505 })).status, 400); assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
      assert.equal(db.listBoards().find(b => b.id !== batch.id).remainingQty, 900);
      assert.equal((await call('/boards/' + batch.id + '/movements', 'POST', out, undefined, 0)).status, 409);
    });
    await t.test('edit and delete preserve inventory, replay and movement guards', async () => {
      const created = (await call('/boards', 'POST', form)).data;
      const url = '/boards/' + created.id;
      for (const [index, invalidBody] of [undefined, null, [], 'not-an-object'].entries()) {
        const before = JSON.stringify(db.backupData());
        const revision = db.revision();
        const response = await fetch(origin + url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `board-edit-invalid-body-${index}`,
            'If-Match': String(revision),
            'X-Warehouse-Device': 'board-test'
          },
          body: invalidBody === undefined ? undefined : JSON.stringify(invalidBody)
        });
        assert.equal(response.status, 400, `invalid body ${String(invalidBody)} remains a client error`);
        await response.text();
        assert.equal(JSON.stringify(db.backupData()), before, 'invalid payload leaves saved batches and movements unchanged');
        assert.equal(db.revision(), revision, 'invalid payload does not advance the data revision');
      }
      const changed = await call(url, 'PUT', { ...form, customerName: '新客户', material: '白卡 / B楞', printPlate: '侧面版', printColor: '蓝色', receivedQty: 1200, boardWidth: 120 }, 'board-edit-replay-001');
      assert.equal(changed.status, 200); assert.equal(changed.data.remainingQty, 1200); assert.equal(changed.data.id, created.id);
      assert.deepEqual([changed.data.customerName, changed.data.material, changed.data.printPlate, changed.data.printColor], ['新客户', '白卡 / B楞', '侧面版', '蓝色']);
      assert.equal((await call(url, 'PUT', { ...form, customerName: '新客户', material: '白卡 / B楞', printPlate: '侧面版', printColor: '蓝色', receivedQty: 1200, boardWidth: 120 }, 'board-edit-replay-001', 0)).status, 200);
      const amountAfterExplicitEdit = changed.data.amount;
      const { customerName, material, printPlate, printColor, ...legacyForm } = form;
      const legacyEdit = await call(url, 'PUT', { ...legacyForm, receivedQty: 1200, boardWidth: 120 }, 'board-edit-legacy-payload-001');
      assert.equal(legacyEdit.status, 200, legacyEdit.message);
      assert.deepEqual(
        [legacyEdit.data.customerName, legacyEdit.data.material, legacyEdit.data.printPlate, legacyEdit.data.printColor],
        ['新客户', '白卡 / B楞', '侧面版', '蓝色'],
        'an older client that omits new label fields preserves saved batch values'
      );
      assert.equal(legacyEdit.data.amount, amountAfterExplicitEdit, 'legacy edit preserves existing billing calculation');
      const clearedEdit = await call(url, 'PUT', {
        ...legacyForm, customerName: '', material: '再生纸 / B楞', printPlate: '', printColor: '专色蓝',
        receivedQty: 1200, boardWidth: 120
      }, 'board-edit-explicit-labels-001');
      assert.equal(clearedEdit.status, 200, clearedEdit.message);
      assert.deepEqual(
        [clearedEdit.data.customerName, clearedEdit.data.material, clearedEdit.data.printPlate, clearedEdit.data.printColor],
        ['', '再生纸 / B楞', '', '专色蓝'],
        'explicit empty strings clear fields while explicit values can still change'
      );
      assert.equal(clearedEdit.data.amount, amountAfterExplicitEdit, 'business label edits do not change the billed amount');
      require('./boards').validate(db.backupData());
      const before = JSON.stringify(db.backupData());
      assert.equal((await call(url, 'PUT', { ...form, date: '2026-02-30' })).status, 400);
      assert.equal(JSON.stringify(db.backupData()), before);
      assert.equal((await call('/boards/' + batch.id, 'PUT', form)).status, 400);
      assert.equal((await call('/boards/' + batch.id, 'DELETE')).status, 400);
      assert.equal((await call(url, 'DELETE', undefined, 'board-delete-replay-001')).status, 200);
      assert.equal((await call(url, 'DELETE', undefined, 'board-delete-replay-001', 0)).status, 200);
      assert.equal((await call(url)).status, 404); require('./boards').validate(db.backupData());
    });
    await t.test('count adjustment keeps audit trail and survives reload', async () => {
      const result = await call('/boards/' + batch.id + '/movements', 'POST', { type: 'count', quantity: 500, remark: '清点少4张' }); assert.equal(result.status, 200, result.message); assert.equal(result.data.movements[0].quantity, -4);
      const backup = db.backupData(); require('./boards').validate(backup);
      const legacy = structuredClone(backup);
      for (const field of ['customerName', 'material', 'printPlate', 'printColor']) delete legacy.board_batches[0][field];
      require('./boards').validate(legacy);
      const invalidLabelBackup = structuredClone(backup); invalidLabelBackup.board_batches[0].printColor = '红\u0000黑';
      assert.throws(() => require('./boards').validate(invalidLabelBackup), /印刷颜色/);
      const corrupt = structuredClone(backup); corrupt.board_batches[0].remainingQty++; assert.throws(() => db.restoreData(corrupt), /纸板/);
      db.restoreData(backup); delete require.cache[require.resolve('./db')]; const reloaded = require('./db'); assert.equal(reloaded.listBoards().find(b => b.id === batch.id).remainingQty, 500);
      assert.equal((await call('/boards/' + batch.id)).data.movements.length, 3);
      assert.equal((await call('/boards/unknown')).status, 404);
    });
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
