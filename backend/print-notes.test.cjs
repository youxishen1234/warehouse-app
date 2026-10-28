const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateNote, normalizeSpecification, removeDuplicates, list, save, remove } = require('./print-notes');
const fixture = () => ({ company: '东光县曙光纸箱包装', customer_id: null, customer_name: '测试客户', address: '测试地址', phone: '123456', receiver: '王先生', sender: '李师傅', date: '2026-10-09', paper: '241-93',
  items: [{ name: '瓦楞纸箱', specification: '400mm x 300毫米 * 200 mm', unit: '箱', quantity: '3', price: '1.005', amount: 999, remark: '' }] });

test('delivery note validation normalizes dimensions and unit, calculates cents, and rejects invalid rows', () => {
  assert.equal(normalizeSpecification('400＊300乘200'), '400×300×200');
  const note = validateNote(fixture());
  assert.equal(note.items[0].specification, '400×300×200');
  assert.equal(note.items[0].unit, '个');
  assert.equal(note.items[0].price, 1.005);
  assert.equal(note.items[0].amount, 3.02);
  assert.equal(note.total, 3.02);
  const unnamed = validateNote({ ...fixture(), items: [{ ...fixture().items[0], name: '' }] });
  assert.equal(unnamed.items[0].name, '');
  for (const field of ['quantity', 'price']) for (const value of ['', null, -1, Infinity, 'abc', '1.0000001']) {
    const raw = fixture(); raw.items[0][field] = value; assert.throws(() => validateNote(raw), /无效|数字|非负|正数|小数/);
  }
  for (const patch of [{ date: '2026-02-30' }, { date: '1791550000' }, { customer_name: '' }, { items: [] }, { items: Array(201).fill(fixture().items[0]) }]) assert.throws(() => validateNote({ ...fixture(), ...patch }));
});

test('automatic cleanup hides newer exact unshipped drafts and preserves shipped or distinct notes', () => {
  const base = validateNote(fixture());
  const stored = (id, createdAt, patch = {}) => ({ ...base, ...patch, id, number: `SH-${id}`, version: 1, created_at: createdAt, updated_at: createdAt });
  const original = stored(1, 100);
  const duplicate = stored(2, 200);
  const shipped = stored(3, 150, { outbound_at: 300 });
  const distinct = stored(4, 200, { receiver: '另一个收货人' });
  const data = { print_notes: [duplicate, shipped, original, distinct] };

  assert.deepEqual(removeDuplicates(data), [2]);
  assert.equal(data.print_notes.find(note => note.id === 2).deleted_at > 0, true);
  assert.equal(data.print_notes.find(note => note.id === 2).version, 2);
  assert.deepEqual(list(data).map(note => note.id).sort((a, b) => a - b), [1, 3, 4]);
  assert.deepEqual(removeDuplicates(data), []);
});

test('temporary print marker survives draft edits without changing the document payload', () => {
  const data = { print_notes: [] };
  const original = save(data, fixture());
  original.temporary_print_at = 1234;
  const updated = save(data, { ...original, receiver: '修改后的收货人' }, original.id);
  assert.equal(updated.temporary_print_at, 1234);
  assert.equal(updated.receiver, '修改后的收货人');
  assert.equal(updated.version, 2);
});

test('unshipped notes can be deleted while shipped notes remain as audit records', () => {
  const data = { print_notes: [] };
  const draft = save(data, fixture());
  const shipped = save(data, { ...fixture(), receiver: '已出库客户' });
  shipped.outbound_at = Date.now();
  const removed = remove(data, draft.id);
  assert.equal(removed.id, draft.id);
  assert.ok(removed.deleted_at > 0);
  assert.ok(data.print_notes.find(note => note.id === draft.id).deleted_at > 0);
  assert.equal(data.print_notes.find(note => note.id === draft.id).version, 2);
  assert.deepEqual(list(data).map(note => note.id), [shipped.id]);
  assert.throws(() => remove(data, shipped.id), /已出库/);
});

test('saved notes persist, update in place, search all lines, reject stale edits, and survive older backups', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-print-notes-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(dir, 'dimensions.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('./db');
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api', require('./team')(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let sequence = 0;
  const call = async (url, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'If-Match': String(db.revision()), 'Idempotency-Key': `print-notes-test-${++sequence}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    const customer = db.addCustomer({ name: '包装客户', address: '客户地址', phone: '13800000000', contact: '王先生' });
    const product = db.addProduct({ name: '瓦楞纸箱', specification: '400×300×200', unit: '个', stock: 10, price: 1.005 });
    const product2 = db.addProduct({ name: '第二行商品', specification: '300×200×150', unit: '个', stock: 10, price: 1.005 });
    const before = db.backupData();
    const raw = { ...fixture(), customer_id: customer.id };
    raw.items[0].product_id = product.id;
    const created = await call('/print-notes', 'POST', raw, { 'Idempotency-Key': 'print-note-replay-001' });
    assert.equal(created.status, 200); const saved = created.data;
    const replay = await call('/print-notes', 'POST', raw, { 'Idempotency-Key': 'print-note-replay-001' });
    assert.deepEqual(replay.data, saved); assert.equal(db.listPrintNotes().length, 1);
    const duplicateContent = await call('/print-notes', 'POST', raw);
    assert.equal(duplicateContent.data.id, saved.id); assert.equal(db.listPrintNotes().length, 1);
    const updated = await call(`/print-notes/${saved.id}`, 'PUT', { ...saved, receiver: '新收货人', items: [...saved.items, { ...saved.items[0], product_id: product2.id, name: '第二行商品', specification: '300×200×150', quantity: 5 }] });
    updated.data.items[1].product_id = product2.id;
    assert.equal(updated.status, 200); assert.equal(updated.data.version, 2);
    assert.equal(updated.data.number, saved.number); assert.equal(updated.data.total, 8.05);
    assert.equal((await call(`/print-notes/${saved.id}`)).data.receiver, '新收货人');
    assert.equal((await call('/print-notes?keyword=' + encodeURIComponent('第二行商品'))).data.total, 1);
    assert.equal((await call('/print-notes?keyword=missing')).data.total, 0);
    const stale = await call(`/print-notes/${saved.id}`, 'PUT', { ...saved, sender: '不能覆盖' });
    assert.equal(stale.status, 409); assert.equal(db.listPrintNotes()[0].receiver, '新收货人');
    const temporary = await call(`/print-notes/${saved.id}/temporary-print`, 'POST', {});
    assert.equal(temporary.status, 200); assert.ok(temporary.data.temporary_print_at > 0);
    assert.equal(db.getProduct(product.id).stock, 10); assert.equal(db.getProduct(product2.id).stock, 10);
    assert.equal(db.getCustomer(customer.id).debt, 0); assert.equal(db.listTx().length, 0);
    const temporaryAgain = await call(`/print-notes/${saved.id}/temporary-print`, 'POST', {});
    assert.equal(temporaryAgain.data.temporary_print_at, temporary.data.temporary_print_at);
    assert.equal(temporaryAgain.data.version, temporary.data.version);
    const deletable = await call('/print-notes', 'POST', { ...raw, receiver: '待删除收货人' });
    assert.equal(deletable.status, 200);
    const deleted = await call(`/print-notes/${deletable.data.id}`, 'DELETE');
    assert.equal(deleted.status, 200); assert.equal(deleted.data.id, deletable.data.id); assert.ok(deleted.data.deleted_at > 0);
    assert.equal((await call(`/print-notes/${deletable.data.id}`)).status, 404);
    assert.ok(JSON.parse(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE)).print_notes.find(note => note.id === deletable.data.id).deleted_at > 0);
    const noKey = await call('/print-notes', 'POST', raw, { 'Idempotency-Key': '' }); assert.equal(noKey.status, 400);
    assert.equal((await call('/print-notes?page=0')).status, 400);
    assert.equal((await call('/print-notes/9999')).status, 404);
    const after = db.backupData();
    for (const collection of ['products', 'customers', 'transactions', 'ledger', 'orders', 'delivery_notes']) assert.deepEqual(after[collection], before[collection], collection);
    assert.equal(JSON.parse(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE)).print_notes[0].receiver, '新收货人');
    const shipped = db.shipPrintNote(saved.id);
    assert.equal(shipped.outbound_at > 0, true);
    assert.equal(shipped.outbound_no.startsWith('CK'), true);
    assert.equal(db.getProduct(product.id).stock, 7);
    assert.equal(db.getProduct(product2.id).stock, 5);
    assert.equal(db.getCustomer(customer.id).debt, 8.05);
    const shippedAgain = db.shipPrintNote(saved.id);
    assert.equal(shippedAgain.outbound_no, shipped.outbound_no);
    assert.equal(db.getProduct(product.id).stock, 7);
    const deleteShipped = await call(`/print-notes/${saved.id}`, 'DELETE');
    assert.equal(deleteShipped.status, 409); assert.match(deleteShipped.message, /已出库/);
    const bad = structuredClone(after); bad.print_notes[0].items[0].amount = 999;
    assert.throws(() => db.restoreData(bad), /送货单备份/);
    assert.equal(db.listPrintNotes()[0].total, 8.05);
    const oldBackup = structuredClone(after); delete oldBackup.print_notes; db.restoreData(oldBackup);
    assert.equal(db.listPrintNotes()[0].receiver, '新收货人'); assert.equal(db.listPrintNotes()[0].version, 5);
    db.restoreData(after); assert.equal(db.listPrintNotes()[0].version, 6);
    const unnamedRaw = fixture(); unnamedRaw.customer_id = customer.id; unnamedRaw.items[0].name = '';
    const unnamed = await call('/print-notes', 'POST', unnamedRaw);
    assert.equal(unnamed.status, 200);
    assert.equal((await call('/print-notes/' + unnamed.data.id)).data.items[0].name, '');
    const beforeRejectedShip = db.backupData();
    const unmatched = await call('/print-notes/' + unnamed.data.id + '/ship', 'POST', {});
    assert.equal(unmatched.status, 400);
    assert.match(unmatched.message, /唯一匹配库存/);
    assert.deepEqual(db.backupData().products, beforeRejectedShip.products);
    assert.deepEqual(db.backupData().transactions, beforeRejectedShip.transactions);
    assert.equal(db.listPrintNotes().find(note => note.id === unnamed.data.id).outbound_at, undefined);
    const linked = await call('/print-notes/' + unnamed.data.id, 'PUT', { ...unnamed.data, items: [{ ...unnamed.data.items[0], product_id: product.id }] });
    assert.equal(linked.status, 200, JSON.stringify(linked));
    const linkedShip = await call('/print-notes/' + unnamed.data.id + '/ship', 'POST', {});
    assert.equal(linkedShip.status, 200);
    assert.ok(linkedShip.data.outbound_at);
    assert.equal(linkedShip.data.items[0].name, '');
    db.addProduct({ name: product.name, specification: product.specification, unit: '个', stock: 10, price: 1 });
    const ambiguous = await call('/print-notes', 'POST', { ...fixture(), customer_id: customer.id });
    const beforeAmbiguousShip = db.backupData();
    const ambiguousShip = await call('/print-notes/' + ambiguous.data.id + '/ship', 'POST', {});
    assert.equal(ambiguousShip.status, 400);
    assert.match(ambiguousShip.message, /唯一匹配库存/);
    assert.deepEqual(db.backupData().products, beforeAmbiguousShip.products);
    assert.deepEqual(db.backupData().transactions, beforeAmbiguousShip.transactions);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // dir is created by mkdtemp for this test alone.
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
