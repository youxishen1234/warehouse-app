const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateNote, normalizeSpecification } = require('./print-notes');
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
  for (const field of ['quantity', 'price']) for (const value of ['', null, -1, Infinity, 'abc', '1.0000001']) {
    const raw = fixture(); raw.items[0][field] = value; assert.throws(() => validateNote(raw), /无效|数字|非负|正数|小数/);
  }
  for (const patch of [{ date: '2026-02-30' }, { date: '1791550000' }, { customer_name: '' }, { items: [] }, { items: Array(201).fill(fixture().items[0]) }]) assert.throws(() => validateNote({ ...fixture(), ...patch }));
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
    const updated = await call(`/print-notes/${saved.id}`, 'PUT', { ...saved, receiver: '新收货人', items: [...saved.items, { ...saved.items[0], product_id: product2.id, name: '第二行商品', specification: '300×200×150', quantity: 5 }] });
    updated.data.items[1].product_id = product2.id;
    assert.equal(updated.status, 200); assert.equal(updated.data.version, 2);
    assert.equal(updated.data.number, saved.number); assert.equal(updated.data.total, 8.05);
    assert.equal((await call(`/print-notes/${saved.id}`)).data.receiver, '新收货人');
    assert.equal((await call('/print-notes?keyword=' + encodeURIComponent('第二行商品'))).data.total, 1);
    assert.equal((await call('/print-notes?keyword=missing')).data.total, 0);
    const stale = await call(`/print-notes/${saved.id}`, 'PUT', { ...saved, sender: '不能覆盖' });
    assert.equal(stale.status, 409); assert.equal(db.listPrintNotes()[0].receiver, '新收货人');
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
    const bad = structuredClone(after); bad.print_notes[0].items[0].amount = 999;
    assert.throws(() => db.restoreData(bad), /送货单备份/);
    assert.equal(db.listPrintNotes()[0].total, 8.05);
    const oldBackup = structuredClone(after); delete oldBackup.print_notes; db.restoreData(oldBackup);
    assert.equal(db.listPrintNotes()[0].receiver, '新收货人'); assert.equal(db.listPrintNotes()[0].version, 4);
    db.restoreData(after); assert.equal(db.listPrintNotes()[0].version, 5);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // dir is created by mkdtemp for this test alone.
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
