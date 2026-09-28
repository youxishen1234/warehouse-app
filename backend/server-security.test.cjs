const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('server restricts CORS origins and does not trust spoofed forwarding headers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-server-security-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(dir, 'accounts.json');
  process.env.WAREHOUSE_TRUSTED_PROXY_CIDRS = '10.0.0.1/32';
  process.env.WAREHOUSE_WRITE_RATE_LIMIT = '20';
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const install = require('./team');
  await install.bootstrap(process.env.WAREHOUSE_ACCOUNTS_FILE, 'Security-test-password!');
  const app = require('./server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const allowed = await fetch(base + '/api/health', { headers: { Origin: 'https://youxishen.online' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://youxishen.online');
    assert.equal(allowed.headers.get('vary'), 'Origin');
    assert.equal(allowed.headers.get('access-control-expose-headers'), 'X-Warehouse-Revision');

    const preflight = await fetch(base + '/api/stats', { method: 'OPTIONS', headers: { Origin: 'https://youxishen.online', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://youxishen.online');

    const rejected = await fetch(base + '/api/stats', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
    assert.equal((await rejected.json()).success, false);

    const direct = await fetch(base + '/api/health');
    assert.equal(direct.headers.get('access-control-allow-origin'), null);
    const uploadIndex = await fetch(base + '/uploads/products/');
    assert.equal(uploadIndex.status, 404, 'product upload directory must not be enumerable');
    const traversal = await fetch(base + '/uploads/products/../accounts.json');
    assert.notEqual(traversal.status, 200, 'uploads route must not expose files outside its directory');

    const oversizedJson = JSON.stringify({ name: 'x'.repeat(1.1 * 1024 * 1024) });
    const generalLimit = await fetch(base + '/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: oversizedJson });
    assert.equal(generalLimit.status, 413);
    assert.equal(generalLimit.headers.get('content-type')?.includes('application/json'), true);
    assert.match((await generalLimit.json()).message, /请求内容过大/);
    const imageWithinLimit = JSON.stringify({ data: 'data:image/png;base64,' + 'A'.repeat(2.1 * 1024 * 1024) });
    const imageAllowed = await fetch(base + '/api/products/1/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: imageWithinLimit });
    assert.notEqual(imageAllowed.status, 413, 'image route keeps its larger 3 MiB JSON limit');
    assert.equal(imageAllowed.status, 401, 'auth is checked after the image body limit');
    const imageOverLimit = JSON.stringify({ data: 'data:image/png;base64,' + 'A'.repeat(3.1 * 1024 * 1024) });
    const imageLimit = await fetch(base + '/api/products/1/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: imageOverLimit });
    assert.equal(imageLimit.status, 413);
    assert.match((await imageLimit.json()).message, /图片请求内容过大/);

    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Security-test-password!' }) });
    const token = (await login.json()).data.token;
    let limited = null;
    for (let index = 0; index < 24 && !limited; index++) {
      const response = await fetch(base + '/api/products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Warehouse-Device': 'security-device',
          'X-Forwarded-For': `198.51.100.${index + 1}`,
          'Idempotency-Key': `security-rate-${String(index).padStart(3, '0')}`,
          'If-Match': '0'
        },
        body: JSON.stringify({ name: '' })
      });
      if (response.status === 429) limited = response;
      else await response.text();
    }
    assert.ok(limited, 'rate limit should trigger');
    assert.equal(limited.headers.get('retry-after'), '60');
    const spoofAttempt = await fetch(base + '/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Warehouse-Device': 'security-device', 'X-Forwarded-For': '203.0.113.7', 'Idempotency-Key': 'security-rate-spoof', 'If-Match': '0' },
      body: JSON.stringify({ name: '' })
    });
    assert.equal(spoofAttempt.status, 429);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
