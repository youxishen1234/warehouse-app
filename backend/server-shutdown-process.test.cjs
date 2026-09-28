const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

test('real SIGTERM drains an in-flight HTTP response before process exit', { skip: process.platform === 'win32' ? 'Windows child_process.kill does not deliver POSIX SIGTERM semantics' : false }, async () => {
  const child = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const install = require('./graceful-shutdown');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const server = http.createServer((req, res) => {
      if (req.url === '/slow') return gate.then(() => res.end('drained'));
      res.end('ok');
    });
    install(server, { timeoutMs: 3000 });
    server.listen(0, '127.0.0.1', () => { process.stdout.write('PORT:' + server.address().port + '\\n'); });
    setTimeout(() => release(), 150);
  `], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not announce a port')), 3000);
    child.stdout.on('data', () => {
      const match = /PORT:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('error', reject);
  });
  const response = await fetch(`http://127.0.0.1:${port}/slow`);
  child.kill('SIGTERM');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'drained');
  const exitCode = await new Promise(resolve => child.once('exit', code => resolve(code)));
  assert.equal(exitCode, 0);
});
