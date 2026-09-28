const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const install = require('./team');

test('unexpected API errors return a generic Chinese message and request id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-error-contract-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const password = 'Error-contract-password!';
  const fakeDb = {
    revision: () => 7,
    stats: () => { throw new Error(`internal file path: ${path.join(dir, 'data.json')}`); }
  };
  const app = express();
  app.use(express.json());
  const previousAccounts = process.env.WAREHOUSE_ACCOUNTS_FILE;
  const router = install(fakeDb);
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const guest = await fetch(origin + '/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(guest.status, 200);
    const token = (await guest.json()).data.token;
    const response = await fetch(origin + '/stats', {
      headers: { Authorization: `Bearer ${token}`, 'X-Request-Id': 'error-contract-request' }
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('x-request-id'), 'error-contract-request');
    const body = await response.json();
    assert.deepEqual(body, { success: false, message: '服务器暂时无法处理请求' });
    assert.equal(JSON.stringify(body).includes(dir), false);
    assert.equal(JSON.stringify(body).includes('internal file path'), false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previousAccounts === undefined) delete process.env.WAREHOUSE_ACCOUNTS_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
