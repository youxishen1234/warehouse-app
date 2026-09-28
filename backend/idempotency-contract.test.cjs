const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const install = require('./team');

test('write routes share one idempotency-key format contract before domain validation', async () => {
  const db = {
    revision: () => 0,
    health: () => ({ online: true, dataReadable: true, dataWritable: true }),
    listProducts: () => [],
    listLedger: () => [],
    stats: () => ({}),
    audit: () => []
  };
  const app = express(); app.use(express.json()); app.use('/api', install(db));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    for (const [route, body] of [
      ['/products', { name: '' }],
      ['/ledger', { type: 'income', amount: 1 }],
      ['/stock/out', { product_id: 1, quantity: 1 }],
      ['/stock/out/batch', { lines: [{ product_id: 1, quantity: 1 }] }],
      ['/orders/1/outbound', { lines: [{ product_id: 1, quantity: 1 }] }],
      ['/stocktake', { product_id: 1, counted_stock: 1 }],
      ['/backup', { data: {} }],
      ['/delivery-notes', { lines: [{ product_id: 1, quantity: 1 }] }],
      ['/products/1/image', { data: 'data:image/png;base64,AA==' }]
    ]) {
      const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400, route);
      assert.match((await response.json()).message, /提交编号/);
    }
    const deletion = await fetch(base + '/delivery-notes/1', { method: 'DELETE' });
    assert.equal(deletion.status, 400, 'DELETE /delivery-notes/:id');
    const nested = await fetch(base + '/products', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'short' }, body: '{}' });
    assert.equal(nested.status, 400);
    assert.match((await nested.json()).message, /提交编号/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
