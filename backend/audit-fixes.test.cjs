const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 修复审计缺陷后的回归测试：结算原子性与撤销、订单约束、零价赠品、作废重开、恢复代次、图片重放。
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFz8AAAAASUVORK5CYII=', 'base64');

test('audit fixes hold across real HTTP routes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-audit-fixes-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  process.env.WAREHOUSE_BACKUP_DIR = path.join(dir, 'backups');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('./db');
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api', require('./team')(db));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port + '/api';
  let seq = 0;
  const uploadedFiles = [];
  const key = () => 'audit-fix-' + String(++seq).padStart(8, '0') + '-key';
  const call = async (url, method = 'GET', body, idemKey = key(), revision = db.revision(), extra = {}) => {
    const r = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey, 'If-Match': String(revision), 'X-Warehouse-Device': 'audit-fix-test', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };

  try {
    await t.test('server-side settlement deducts from the CURRENT balance and replays safely', async () => {
      const c = (await call('/customers', 'POST', { name: '结算测试客户', debt: 100 })).data.data;
      assert.equal(c.debt, 100);
      // another device adds 50 receivable (补录)
      await call('/customers/' + c.id, 'PUT', { debt: 150 });
      // settle 100 — the server must use the current balance 150, not the dialog's stale 100
      const settleKey = 'audit-fix-settle-replay-001';
      const s = await call('/customers/' + c.id + '/settlement', 'POST', { amount: 100 }, settleKey);
      assert.equal(s.status, 200, s.data.message);
      assert.equal(s.data.data.balance, 50);
      assert.equal(db.getCustomer(c.id).debt, 50);
      // replay with the SAME key returns the stored result, no double deduction
      const replay = await call('/customers/' + c.id + '/settlement', 'POST', { amount: 100 }, settleKey, 0);
      assert.equal(replay.status, 200, replay.data.message);
      assert.equal(replay.data.data.balance, 50);
      assert.equal(db.getCustomer(c.id).debt, 50);
      // overpay rejected
      const over = await call('/customers/' + c.id + '/settlement', 'POST', { amount: 60 });
      assert.equal(over.status, 400);
    });

    await t.test('settlement reversal restores the balance so voiding the original outbound works', async () => {
      const c = db.addCustomer({ name: '撤销测试客户' });
      const p = db.addProduct({ name: '撤销测试纸箱', stock: 100, price: 2 });
      const out = db.stockOut(p.id, 10, 't', '', c.id);
      assert.equal(db.getCustomer(c.id).debt, 20);
      const settle = db.settleParty('customer', c.id, 20, '结清');
      assert.equal(db.getCustomer(c.id).debt, 0);
      const ledgers = db.listLedger().filter(l => l.type === 'settlement' && l.party_id === c.id);
      assert.equal(ledgers.length, 1);
      db.deleteLedger(ledgers[0].id);
      assert.equal(db.getCustomer(c.id).debt, 20, '撤销结算后应收恢复');
      const del = await call('/transactions/' + out.transaction.id, 'DELETE');
      assert.equal(del.status, 200, del.data.message);
      assert.equal(db.getCustomer(c.id).debt, 0);
      assert.equal(db.getProduct(p.id).stock, 100);
    });

    await t.test('order quantity cannot drop below shipped and party is locked after shipment', async () => {
      const c = db.addCustomer({ name: '订单约束客户' });
      const p = db.addProduct({ name: '订单约束纸箱', stock: 100, price: 2, unit: '个' });
      const order = db.addOrder({ order_no: 'FIX-001', customer_id: c.id, quantity: 10, unit_price: 2, unit: '个', status: '生产中' });
      db.orderToOutbound(order.id, [{ product_id: p.id, quantity: 6 }], 't', '');
      const low = await call('/orders/' + order.id, 'PUT', { quantity: 2 });
      assert.equal(low.status, 400, '数量低于已发货量必须被拒绝');
      const ok = await call('/orders/' + order.id, 'PUT', { quantity: 8 });
      assert.equal(ok.status, 200, ok.data.message);
      const other = db.addCustomer({ name: '另一客户' });
      const swap = await call('/orders/' + order.id, 'PUT', { customer_id: other.id });
      assert.equal(swap.status, 400, '发货后不能更换客户');
    });

    await t.test('zero-price gifts linked to a party can move stock without AR ledger', async () => {
      const c = db.addCustomer({ name: '赠品客户' });
      const p = db.addProduct({ name: '免费样', stock: 10, price: 0 });
      const r = await call('/stock/out', 'POST', { product_id: p.id, quantity: 2, customer_id: c.id });
      assert.equal(r.status, 200, r.data.message);
      assert.equal(db.getProduct(p.id).stock, 8);
      assert.equal(db.getCustomer(c.id).debt, 0, '零价赠品不产生应收');
      const tx = db.listTx().find(t => t.product_id === p.id);
      assert.equal(tx.customer_id, c.id, '往来关联保留');
      // void works too
      const del = await call('/transactions/' + tx.id, 'DELETE');
      assert.equal(del.status, 200, del.data.message);
      assert.equal(db.getProduct(p.id).stock, 10);
    });

    await t.test('voiding outbound on a completed order reopens it for re-shipment', async () => {
      const c = db.addCustomer({ name: '补发客户' });
      const p = db.addProduct({ name: '补发纸箱', stock: 50, price: 3 });
      const order = db.addOrder({ order_no: 'FIX-002', customer_id: c.id, quantity: 10, unit_price: 3, status: '生产中' });
      const out = db.orderToOutbound(order.id, [{ product_id: p.id, quantity: 10 }], 't', '');
      db.updateOrder(order.id, { status: '已完成' });
      const txId = out.transactions[0].transaction.id;
      const del = await call('/transactions/' + txId, 'DELETE');
      assert.equal(del.status, 200, del.data.message);
      assert.equal(db.listOrders().find(o => o.id === order.id).status, '生产中', '已完成订单作废后重开');
      const again = db.orderToOutbound(order.id, [{ product_id: p.id, quantity: 10 }], 't', '');
      assert.equal(again.transactions.length, 1);
    });

    await t.test('restore bumps the data generation so pre-restore receipts fail clearly', async () => {
      const p = db.addProduct({ name: '代次测试箱', stock: 20, price: 1 });
      const before = db.backupData();
      const result = await call('/stock/out', 'POST', { product_id: p.id, quantity: 3 }, 'audit-fix-generation-001');
      assert.equal(result.status, 200);
      assert.equal(db.getProduct(p.id).stock, 17);
      const restored = await call('/backup', 'POST', { data: before }, 'audit-fix-restore-001');
      assert.equal(restored.status, 200, restored.data.message);
      assert.equal(db.getProduct(p.id).stock, 20, '恢复到备份时的库存');
      // replaying the pre-restore write key must NOT silently re-execute
      const replay = await call('/stock/out', 'POST', { product_id: p.id, quantity: 3 }, 'audit-fix-generation-001', 0);
      assert.equal(replay.status, 409, '恢复后旧回执必须明确失败');
      assert.equal(db.getProduct(p.id).stock, 20, '不得重复扣库存');
    });

    await t.test('replaying an old image upload keeps the current image file', async () => {
      const p = db.addProduct({ name: '图片重放箱', stock: 5, price: 1 });
      const upload = async (idemKeyValue, payload, revision = db.revision()) => {
        const r = await fetch(origin + '/products/' + p.id + '/image', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKeyValue, 'If-Match': String(revision), 'X-Warehouse-Device': 'audit-fix-test' }, body: JSON.stringify(payload) });
        return { status: r.status, data: await r.json() };
      };
      const a = await upload('audit-fix-image-a-001', { data: 'data:image/png;base64,' + TINY_PNG.toString('base64') });
      assert.equal(a.status, 200, a.data.message);
      const urlA = db.getProduct(p.id).image_url; uploadedFiles.push(urlA.split('/').pop());
      const b = await upload('audit-fix-image-b-001', { data: 'data:image/png;base64,' + Buffer.concat([TINY_PNG, Buffer.from('second')]).toString('base64') });
      assert.equal(b.status, 200, b.data.message);
      const urlB = db.getProduct(p.id).image_url; uploadedFiles.push(urlB.split('/').pop());
      assert.notEqual(urlA, urlB);
      const fileB = path.join(__dirname, 'public', 'uploads', 'products', urlB.split('/').pop());
      assert.equal(fs.existsSync(fileB), true);
      // replay A: must not delete B
      const replay = await upload('audit-fix-image-a-001', { data: 'data:image/png;base64,' + TINY_PNG.toString('base64') }, 0);
      assert.equal(replay.status, 200);
      assert.equal(db.getProduct(p.id).image_url, urlB, '数据库仍指向当前图片');
      assert.equal(fs.existsSync(fileB), true, '当前图片文件不得被重放删除');
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    // 只清理本测试上传的图片文件，避免并行测试间相互干扰。
    const uploads = path.join(__dirname, 'public', 'uploads', 'products');
    try { for (const name of uploadedFiles) fs.unlinkSync(path.join(uploads, name)); } catch (e) { /* best effort */ }
  }
});
