const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const install = require('./team');
const { SORT_FIELDS, ORDER_STATUSES, sortList } = require('./list-sort');

test('list sorting has stable ties, handles legacy values and does not mutate input', () => {
  const rows = [{ id: 3, price: 10 }, { id: 2, price: 2 }, { id: 1, price: 2 }, { id: 4 }, { id: 5, price: NaN }];
  const before = structuredClone(rows);
  assert.equal(sortList(rows, {}, 'products'), rows, 'no sort preserves the exact existing order');
  assert.deepEqual(sortList(rows, { sort: 'price', order: 'asc' }, 'products').map(row => row.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(sortList(rows, { sort: 'price' }, 'products').map(row => row.id), [3, 2, 1, 5, 4]);
  assert.deepEqual(rows, before);
  const legacy = [{ id: 1, updated_at: 40 }, { id: 2, created_at: 20 }, { id: 3, profile_updated_at: 30, updated_at: 60 }];
  assert.deepEqual(sortList(legacy, { order: 'asc' }, 'products').map(row => row.id), [2, 3, 1]);
  assert.deepEqual(sortList([{ id: 2, name: '阿' }, { id: 1, name: '波' }], { sort: 'name', order: 'asc' }, 'products').map(row => row.id), [2, 1]);
});

test('all list routes and CSV exports validate sorting and order status through HTTP', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-query-test-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(dir, 'accounts.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  await install.bootstrap(process.env.WAREHOUSE_ACCOUNTS_FILE, 'Query-test-password!');
  const db = require('./db');
  const app = express(); app.use(express.json()); app.use('/api', install(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let token = '', sequence = 0;
  const call = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
      'Idempotency-Key': `query-contract-${String(++sequence).padStart(4, '0')}`, 'If-Match': String(db.revision())
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(raw) : raw };
  };
  const create = async (url, body) => {
    const result = await call(url, 'POST', body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.data;
  };
  const ids = rows => rows.map(row => row.id);
  try {
    token = (await call('/auth/guest', 'POST', {})).body.data.token;
    for (let index = 1; index <= 3; index++) {
      const product = await create('/products', { name: `排序商品${index}`, price: index === 3 ? 2 : index * 2, stock: 10 });
      await create('/customers', { name: `排序客户${index}` });
      await create('/suppliers', { name: `排序供应商${index}` });
      await create('/stock/in', { product_id: product.id, quantity: index, unit_price: index });
      await create('/ledger', { type: 'income', amount: index, remark: `sort-ledger-${index}` });
      await create('/stocktake', { product_id: product.id, counted_stock: 20 });
      await create('/delivery-notes', { date: '2026-09-26', lines: [{ product_id: product.id, quantity: 1, delivered_qty: 1, unit_price: 1 }] });
    }
    const orders = [];
    for (const [index, status] of ORDER_STATUSES.entries()) {
      orders.push(await create('/orders', { order_no: `QUERY-${index}`, quantity: 1, status }));
    }
    await create('/orders', { order_no: 'QUERY-extra', quantity: 1 });
    await call(`/orders/${orders[0].id}`, 'PUT', { status: '生产中' });
    await call(`/orders/${orders[0].id}`, 'PUT', { status: '已发货' });
    const endpoints = Object.keys(SORT_FIELDS).map(resource => ({ resource,
      route: resource === 'order_events' ? `/orders/${orders[0].id}/events` : `/${resource.replace('_', '-')}`
    }));

    await t.test('sorting precedes pagination on nine resource lists and leaves default data unchanged', async () => {
      const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
      for (const { resource, route } of endpoints) {
        const original = (await call(route)).body.data;
        assert(original.length >= 2, `${resource} must have multiple rows`);
        const expected = [...original].sort((a, b) => a.id - b.id);
        const ascending = await call(`${route}?sort=id&order=asc`);
        assert.equal(ascending.status, 200);
        assert.deepEqual(ids(ascending.body.data), ids(expected), resource);
        const descending = await call(`${route}?sort=id`);
        assert.deepEqual(ids(descending.body.data), ids([...expected].reverse()), resource);
        const second = await call(`${route}?sort=id&order=asc&page=2&page_size=1`);
        assert.deepEqual(second.body.data, { items: expected.slice(1, 2), total: expected.length, page: 2, page_size: 1 }, resource);
        for (const field of Object.keys(SORT_FIELDS[resource])) {
          const result = await call(`${route}?sort=${field}&order=asc`);
          assert.equal(result.status, 200, `${resource}.${field} is a documented supported field`);
          assert.equal(result.body.data.length, original.length);
          assert.deepEqual([...ids(result.body.data)].sort((a, b) => a - b), ids(expected));
        }
        assert.deepEqual((await call(route)).body.data, original, 'explicit sorting must not affect later default requests');
      }
      const products = await call('/products?sort=price&order=asc');
      assert.deepEqual(products.body.data.map(row => row.price), [2, 2, 4]);
      assert.deepEqual(ids(products.body.data), [1, 3, 2]);
      assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before, 'read-only sorting must not change persisted data');
    });

    await t.test('ledger filters apply before pagination and can explicitly include voided history', async () => {
      const marker = `ledger-query-contract-${Date.now()}`;
      const entries = [];
      for (const amount of [30, 10, 20]) entries.push(await create('/ledger', { type: 'income', amount, remark: marker }));
      const voided = await call(`/ledger/${entries[2].id}`, 'DELETE');
      assert.equal(voided.status, 200);

      const filtered = await call(`/ledger?type=income&keyword=${encodeURIComponent(marker)}&include_voided=true&sort=amount&order=asc&page=1&page_size=1`);
      assert.equal(filtered.status, 200);
      assert.equal(filtered.body.data.total, 3);
      assert.equal(filtered.body.data.page, 1);
      assert.equal(filtered.body.data.page_size, 1);
      assert.deepEqual(filtered.body.data.items.map(item => [item.id, item.amount]), [[entries[1].id, 10]]);
      const secondPage = await call(`/ledger?type=income&keyword=${encodeURIComponent(marker)}&include_voided=true&sort=amount&order=asc&page=2&page_size=1`);
      assert.deepEqual(secondPage.body.data.items.map(item => item.id), [entries[2].id]);
      const withoutVoided = await call(`/ledger?type=income&keyword=${encodeURIComponent(marker)}&sort=amount&order=asc&page=1&page_size=10`);
      assert.deepEqual(withoutVoided.body.data.items.map(item => item.id), [entries[1].id, entries[0].id]);
      assert.equal(withoutVoided.body.data.total, 2);
      assert.equal((await call(`/ledger?include_voided=yes`)).status, 400);
      assert.equal((await call(`/ledger?include_voided[]=true`)).status, 400);
    });

    await t.test('order status filters work before pagination and default requests still return every status', async () => {
      const full = (await call('/orders')).body.data;
      for (const status of ORDER_STATUSES) {
        const expected = full.filter(order => order.status === status).sort((a, b) => a.id - b.id);
        const query = `status=${encodeURIComponent(status)}&sort=id&order=asc`;
        assert.deepEqual((await call(`/orders?${query}`)).body.data, expected);
        const page = (await call(`/orders?${query}&page=1&page_size=1`)).body.data;
        assert.deepEqual(page, { items: expected.slice(0, 1), total: expected.length, page: 1, page_size: 1 });
        assert.deepEqual((await call(`/orders?${query}&page=99&page_size=1`)).body.data.items, []);
      }
      assert.deepEqual((await call('/orders')).body.data, full);
    });

    await t.test('unknown, duplicate, nested and cross-resource sort or enum values return Chinese 400 errors', async () => {
      const before = fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
      for (const { resource, route } of endpoints) {
        for (const query of ['sort=missing', 'sort=toString', 'sort=__proto__', 'sort=', 'sort=id&sort=name', 'sort[x]=id', 'order=ascending', 'order=ASC', 'order=', 'order=asc&order=desc', 'order[x]=asc']) {
          const result = await call(`${route}?${query}`);
          assert.equal(result.status, 400, `${resource}: ${query}`);
          assert.equal(result.body.success, false);
          assert.match(result.body.message, /[\u4e00-\u9fff]/);
          if (['sort=missing', 'order=ascending'].includes(query)) assert.match(result.body.message, /允许值/);
        }
        if (resource !== 'orders') assert.equal((await call(`${route}?status=${encodeURIComponent('待生产')}`)).status, 400);
      }
      assert.equal((await call('/products?sort=debt')).status, 400);
      for (const value of ['unknown', '', '待生产 ']) {
        const result = await call(`/orders?status=${encodeURIComponent(value)}`);
        assert.equal(result.status, 400);
        for (const allowed of ORDER_STATUSES) assert(result.body.message.includes(allowed));
      }
      for (const query of ['status[x]=unknown', 'status=unknown&status=unknown']) assert.equal((await call(`/orders?${query}`)).status, 400);
      for (const [url, body] of [['/orders', { order_no: 'QUERY-invalid', quantity: 1, status: 'invalid' }], [`/orders/${orders[0].id}`, { status: 'invalid' }]]) {
        const result = await call(url, url === '/orders' ? 'POST' : 'PUT', body);
        assert.equal(result.status, 400);
        for (const allowed of ORDER_STATUSES) assert(result.body.message.includes(allowed));
      }
      assert.equal(fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8'), before);
    });

    await t.test('CSV exports preserve list filtering and ordering without inheriting page truncation', async () => {
      for (const resource of ['transactions', 'ledger']) {
        const type = resource === 'transactions' ? 'in' : 'income';
        const query = `type=${type}&sort=amount&order=asc`;
        const rows = (await call(`/${resource}?${query}`)).body.data;
        const csv = await call(`/export/${resource}.csv?${query}&page=1&page_size=1`);
        assert.equal(csv.status, 200);
        const lines = csv.body.trim().split('\r\n').slice(1);
        assert.equal(lines.length, rows.length, 'full export must not be truncated by pagination');
        const amountColumn = resource === 'transactions' ? 8 : 2;
        assert.deepEqual(lines.map(line => Number(line.split(',')[amountColumn].replace(/"/g, ''))), rows.map(row => row.amount));
        for (const invalid of ['sort=missing', 'sort=id&sort=amount', 'order=invalid', 'status=unknown', 'type=unknown']) {
          const result = await call(`/export/${resource}.csv?${invalid}`);
          assert.equal(result.status, 400, `${resource}: ${invalid}`);
          assert.match(result.body.message, /[\u4e00-\u9fff]/);
        }
        const empty = await call('/export/' + resource + '.csv?keyword=' + encodeURIComponent('绝对不存在的导出记录'));
        assert.equal(empty.status, 404, resource);
        assert.equal(empty.body.success, false);
        assert.match(empty.body.message, /没有符合条件/);
      }
    });

    await t.test('date filters accept local calendar dates and legacy millisecond timestamps with inclusive end dates', async () => {
      const now = new Date();
      const pad = value => String(value).padStart(2, '0');
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const start = new Date(`${today}T00:00:00`).getTime();
      const end = start + 86400000 - 1;
      const byDate = await call(`/transactions?from=${today}&to=${today}&sort=id&order=asc`);
      const byTimestamp = await call(`/transactions?from=${start}&to=${start}&sort=id&order=asc`);
      assert.equal(byDate.status, 200);
      assert.deepEqual(byDate.body.data, byTimestamp.body.data);
      assert(byDate.body.data.length > 0);
      assert.equal((await call(`/transactions?from=${start + 1}&to=${end}&sort=id&order=asc`)).status, 200);
      for (const query of ['from=2026-02-30', 'to=2026-02-30', 'from=2026/09/27', 'from=1.5', 'from=abc', 'from=2026-09-28&to=2026-09-27']) {
        const result = await call(`/transactions?${query}`);
        assert.equal(result.status, 400, query);
        assert.match(result.body.message, /查询参数|日期|开始日期/);
      }
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
