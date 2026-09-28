const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

test('large CSV exports stream rows while health requests remain responsive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-export-stream-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(dir, 'accounts.json');
  const count = 30000;
  const now = Date.now();
  const transactions = Array.from({ length: count }, (_, index) => ({
    id: index + 1, product_id: 1, product_name: `stream-${index}`, type: 'in', quantity: 1,
    operator: 'test', remark: `row-${index}`, created_at: now - index, specification: '', material: '',
    unit: 'unit', unit_price: 1, amount: 1
  }));
  const ledger = Array.from({ length: count }, (_, index) => ({
    id: index + 1, type: 'income', amount: 1, remark: `ledger-${index}`, party_id: null,
    party_name: '', transaction_id: null, created_at: now - index
  }));
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({
    _meta: { schemaVersion: 1, nextProductId: 2, nextTransactionId: count + 1, nextLedgerId: count + 1 },
    products: [{ id: 1, name: 'stream-product', category: '', specification: '', material: '', corrugation: '',
      unit: 'unit', stock: count, price: 1, safety_stock: 0, deleted_at: null, created_at: now - count, updated_at: now - count }],
    customers: [], suppliers: [], transactions, ledger, orders: [], order_events: [], stocktakes: [], delivery_notes: [], receipts: {}, audit: [], revision: 0
  }));
  const install = require('./team');
  await install.bootstrap(process.env.WAREHOUSE_ACCOUNTS_FILE, 'Export-stream-password!');
  const db = require('./db');
  const app = express();
  app.use(express.json());
  app.use('/api', install(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const login = await fetch(`${base}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const token = (await login.json()).data.token;
    const headers = { Authorization: `Bearer ${token}` };
    const started = Date.now();
    const exportResponse = await fetch(`${base}/export/transactions.csv?sort=id&order=asc`, { headers });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get('content-type') || '', /text\/csv/);
    async function consumeCsv(response, expectedRows) {
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.ok(first.value.length > 0);
      let bytes = first.value.length;
      let text = Buffer.from(first.value).toString('utf8');
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        text += Buffer.from(next.value).toString('utf8');
      }
      const lines = text.split('\r\n').filter(Boolean);
      assert.equal(lines.length, expectedRows + 1, 'header plus every row must be streamed');
      assert.ok(bytes > expectedRows * 40, 'response must contain row data, not only the header');
    }
    await consumeCsv(exportResponse, count);
    const ledgerResponse = await fetch(`${base}/export/ledger.csv?sort=id&order=asc`, { headers });
    assert.equal(ledgerResponse.status, 200);
    await consumeCsv(ledgerResponse, count);
    assert.ok(Date.now() - started < 2000, 'headers and first CSV chunk should arrive promptly');

    const health = await fetch(`${base}/health`, { headers });
    assert.equal(health.status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});