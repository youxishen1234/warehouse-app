const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const install = require('./team');

test('audit HTTP pagination keeps a fixed 50 rows, accurate total, and validates page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-audit-page-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const previousAccounts = process.env.WAREHOUSE_ACCOUNTS_FILE;
  const rows = Array.from({ length: 123 }, (_, index) => ({
    id: index + 1,
    actor_name: `operator-${index + 1}`,
    operation: `operation-${index + 1}`,
    time: index + 1
  }));
  const fakeDb = { revision: () => 7, audit: () => rows };
  const app = express();
  app.use(express.json());
  app.use('/api', install(fakeDb));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const guest = await fetch(`${base}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(guest.status, 200);
    const token = (await guest.json()).data.token;
    const call = async query => {
      const response = await fetch(`${base}/audit${query}`, { headers: { Authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json() };
    };

    const first = await call('');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data, { total: 123, items: rows.slice().reverse().slice(0, 50) });

    const second = await call('?page=2&page_size=1');
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.data, { total: 123, items: rows.slice().reverse().slice(50, 100) }, 'page_size stays fixed at 50 for compatibility');

    const third = await call('?page=3');
    assert.deepEqual(third.body.data, { total: 123, items: rows.slice().reverse().slice(100, 150) });
    const outOfRange = await call('?page=99');
    assert.deepEqual(outOfRange.body.data, { total: 123, items: [] });

    for (const query of ['?page=0', '?page=-1', '?page=1.5', '?page=abc', '?page[]=1', '?page=1&page=2']) {
      const rejected = await call(query);
      assert.equal(rejected.status, 400, query);
      assert.equal(rejected.body.success, false);
      assert.match(rejected.body.message, /\u9875\u7801\u5fc5\u987b/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previousAccounts === undefined) delete process.env.WAREHOUSE_ACCOUNTS_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
