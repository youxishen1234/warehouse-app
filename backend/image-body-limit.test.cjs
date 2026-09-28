const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const install = require('./team');

test('image JSON limit is 2.5 MiB while decoded image bytes remain capped at 2 MiB', async () => {
  const product = { id: 1, name: 'image-limit', image_url: '' };
  const db = {
    revision: () => 0,
    getProduct: () => product,
    updateProduct: (_id, patch) => Object.assign(product, patch),
    transact: (_actor, _key, _fingerprint, _expected, _operation, action) => ({ data: action(), revision: 1 }),
    audit: () => []
  };
  const app = express();
  app.use('/api/products/:id/image', express.json({ limit: '2.5mb' }));
  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api', install(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/products/1/image`;
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'image-limit-test-0001', 'If-Match': '0' };
  const payload = bytes => JSON.stringify({ data: `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8)]).toString('base64')}` });
  try {
    // 1.8 MiB decoded remains below both limits after base64 encoding.
    const valid = await fetch(base, { method: 'POST', headers, body: payload(1.8 * 1024 * 1024) });
    assert.equal(valid.status, 200);
    const jsonOverflow = await fetch(base, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'image-limit-test-0002' }, body: payload(2.0 * 1024 * 1024) });
    assert.equal(jsonOverflow.status, 413);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
