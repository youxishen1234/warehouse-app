const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const install = require('./team');

test('anonymous API keeps business contracts without accounts, passwords or roles', async () => {
  const state = { revision: 0, products: [], audit: [] };
  const db = {
    revision: () => state.revision,
    health: () => ({ online: true, dataReadable: true, dataWritable: true }),
    audit: () => state.audit,
    listProducts: () => state.products,
    addProduct: body => { const product = { id: state.products.length + 1, name: String(body.name || ''), created_at: Date.now() }; state.products.push(product); return product; },
    getProduct: id => state.products.find(product => product.id === Number(id)) || null,
    transact: (actor, key, fingerprint, expected, operation, action) => { if (expected !== String(state.revision)) throw Object.assign(new Error('revision conflict'), { status: 409 }); const data = action(); state.revision += 1; state.audit.push({ actor_name: actor.username, operation, time: Date.now() }); return { data, revision: state.revision }; },
    stats: () => ({ totalProducts: state.products.length })
  };
  const app = express(); app.use(express.json()); app.use('/api', install(db));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const health = await fetch(`${base}/health`); assert.equal(health.status, 200); assert.equal((await health.json()).data.authentication, false);
    const guest = await fetch(`${base}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(guest.status, 200); const guestData = (await guest.json()).data; assert.equal(Object.prototype.hasOwnProperty.call(guestData.user, 'role'), false);
    const created = await fetch(`${base}/products`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'anonymous-product-0001', 'If-Match': '0' }, body: JSON.stringify({ name: '匿名商品' }) });
    assert.equal(created.status, 200); assert.equal(created.headers.get('x-warehouse-revision'), '1'); assert.equal((await created.json()).data.name, '匿名商品'); assert.equal(state.audit[0].actor_name, '匿名用户'); assert.equal(Object.prototype.hasOwnProperty.call(state.audit[0], 'role'), false);
    for (const route of ['/auth/login', '/auth/gate', '/auth/password', '/team']) { const response = await fetch(base + route, { method: route === '/auth/password' ? 'POST' : 'GET' }); assert.equal(response.status, 404, route); }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
