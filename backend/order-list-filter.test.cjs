const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

test('订单列表支持统一关键词、客户和日期筛选', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-order-filter-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const install = require('./team');
  const db = require('./db');
  const app = express(); app.use(express.json()); app.use('/api', install(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let token = ''; let sequence = 0;
  const call = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
      'Idempotency-Key': `order-filter-${String(++sequence).padStart(4, '0')}`,
      'If-Match': String(db.revision())
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    token = (await call('/auth/guest', 'POST', {})).body.data.token;
    const customer = (await call('/customers', 'POST', { name: '筛选客户' })).body.data;
    const first = (await call('/orders', 'POST', { order_no: 'FILTER-ONE', customer_id: customer.id, customer_name: customer.name, remark: '需要重点跟进' })).body.data;
    const second = (await call('/orders', 'POST', { order_no: 'OTHER-TWO', remark: '普通订单' })).body.data;
    const byKeyword = await call('/orders?keyword=' + encodeURIComponent('重点跟进'));
    assert.equal(byKeyword.status, 200);
    assert.deepEqual(byKeyword.body.data.map(row => row.id), [first.id]);
    const byCustomer = await call(`/orders?customer_id=${customer.id}`);
    assert.equal(byCustomer.status, 200);
    assert.deepEqual(byCustomer.body.data.map(row => row.id), [first.id]);
    const today = new Date(); const pad = value => String(value).padStart(2, '0');
    const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const byDate = await call(`/orders?from=${date}&to=${date}&sort=id&order=asc`);
    assert.equal(byDate.status, 200);
    assert.deepEqual(byDate.body.data.map(row => row.id), [first.id, second.id]);
    const paged = await call('/orders?keyword=' + encodeURIComponent('订单') + '&sort=id&order=asc&page=1&page_size=1');
    assert.equal(paged.status, 200);
    assert.deepEqual(paged.body.data, { items: [second], total: 1, page: 1, page_size: 1 });
    const customerPage = await call(`/orders?customer_id=${customer.id}&sort=id&order=asc&page=1&page_size=1`);
    assert.deepEqual(customerPage.body.data, { items: [first], total: 1, page: 1, page_size: 1 });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
