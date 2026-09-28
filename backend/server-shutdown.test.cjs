const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createServer } = require('node:http');
const installGracefulShutdown = require('./graceful-shutdown');

test('SIGTERM stops new accepts and lets an in-flight response finish', async t => {
  let markStarted;
  let finishResponse;
  const started = new Promise(resolve => { markStarted = resolve; });
  const responseGate = new Promise(resolve => { finishResponse = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/slow') {
      markStarted();
      responseGate.then(() => res.end('drained'));
      return;
    }
    res.end('ok');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    if (!server.listening) return;
    return new Promise(resolve => server.close(() => resolve()));
  });

  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const closed = new Promise(resolve => server.once('close', resolve));
  const log = [];
  const runtime = new EventEmitter();
  installGracefulShutdown(server, {
    runtime,
    timeoutMs: 3000,
    logger: { log: message => log.push(message), error: message => log.push(message) }
  });

  const inFlight = fetch(`${origin}/slow`);
  await started;
  runtime.emit('SIGTERM');
  runtime.emit('SIGINT');
  assert.equal(log.filter(message => /draining in-flight/.test(message)).length, 1);
  assert.match(log.find(message => /draining in-flight/.test(message)), /\(1\)/);
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(1000) }));

  finishResponse();
  const response = await inFlight;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'drained');
  await closed;
  assert.ok(log.includes('[server] shutdown complete'));
  assert.equal(log.some(message => /shutdown timed out/.test(message)), false);
});
