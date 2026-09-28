const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const install = require('./team');

test('backend exposes anonymous guest access without account files, roles or password routes', async () => {
  const fakeDb = {
    revision: () => 0,
    health: () => ({ online: true, dataReadable: true, dataWritable: true }),
    stats: () => ({ totalProducts: 0 }),
    listProducts: () => [],
    audit: () => []
  };
  const app = express();
  app.use(express.json());
  app.use('/api', install(fakeDb));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).data.authentication, false);

    const guest = await fetch(`${base}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(guest.status, 200);
    const guestData = (await guest.json()).data;
    assert.equal(typeof guestData.token, 'string');
    assert.equal(guestData.user.username, '匿名用户');
    assert.equal(Object.prototype.hasOwnProperty.call(guestData.user, 'role'), false);

    const me = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${guestData.token}` } });
    assert.equal(me.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call((await me.json()).data, 'role'), false);

    const products = await fetch(`${base}/products`);
    assert.equal(products.status, 200);
    assert.deepEqual((await products.json()).data, []);
    for (const route of ['/auth/login', '/auth/gate', '/auth/password', '/team']) {
      const response = await fetch(`${base}${route}`, { method: route === '/auth/password' ? 'POST' : 'GET' });
      assert.equal(response.status, 404, route);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
