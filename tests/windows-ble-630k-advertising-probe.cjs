const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  assert.equal(process.platform, 'win32', 'This probe requires the Windows BLE peripheral API');
  const helper = process.argv[2];
  assert.ok(helper, 'Pass the isolated helper executable path');
  let healthRequests = 0;
  const unexpectedRequests = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/health' && request.method === 'GET') {
      healthRequests++;
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end(JSON.stringify({ success: true, data: { ready: true } }));
      return;
    }
    unexpectedRequests.push(request.method + ' ' + request.url);
    response.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify({ success: false, code: 'PROBE_ONLY', safeToRetry: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let child;
  let exit;
  let closed = false;
  let stdout = '';
  let stderr = '';
  try {
    child = spawn(helper, [], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WAREHOUSE_BLE_API: `http://127.0.0.1:${server.address().port}`,
        WAREHOUSE_BLE_TOKEN: 'probe-only-'.repeat(8),
        WAREHOUSE_BLE_DEBUG: '1',
        WAREHOUSE_BLE_NAME: 'Warehouse-630K-Probe',
        WAREHOUSE_BLE_PARENT_PID: String(process.pid),
      },
    });
    exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const deadline = Date.now() + 15000;
    while (!closed && Date.now() < deadline) {
      if (/^READY\r?$/m.test(stdout) && /ADVERTISEMENT_STATUS=Started/.test(stderr)) break;
      await delay(100);
    }
    assert.match(stderr, /ADVERTISEMENT_STATUS=Started/, 'BLE did not reach Started: ' + stderr);
    assert.match(stdout, /^READY\r?$/m, 'Helper did not report ready: ' + stdout + stderr);
    await delay(1500);
    assert.equal(closed, false, 'Helper exited unexpectedly after readiness');
    assert.ok(healthRequests > 0, 'Helper did not contact the isolated health server');
    assert.deepEqual(unexpectedRequests, [], 'Probe attempted a job or a non-health endpoint');
    console.log('PASS isolated Windows advertisement: ADVERTISEMENT_STATUS=Started; READY; health requests=' + healthRequests + '; child PID=' + child.pid);
  } finally {
    if (child && !closed) child.kill();
    if (exit) await exit;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    console.log('Probe helper stopped; no radio helper remains from this probe.');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
