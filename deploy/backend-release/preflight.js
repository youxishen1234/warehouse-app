'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.resolve(process.argv[2] || '');
const required = ['server.js', 'db.js', 'team.js', 'daily-backup.js', 'product-image-backup.js', 'ledger-attachments.js', 'business-workflow.js', 'package.json', 'package-lock.json', 'node_modules/express/package.json'];
for (const name of required) if (!fs.existsSync(path.join(root, name))) throw new Error('missing backend release file: ' + name);
const data = path.join(root, '.preflight-data.json');
fs.writeFileSync(data, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
const environment = {
  ...process.env,
  WAREHOUSE_DATA_FILE: data,
  WAREHOUSE_BACKUP_DIR: path.join(root, '.preflight-protection'),
  WAREHOUSE_DAILY_BACKUP_DIR: path.join(root, '.preflight-daily'),
  WAREHOUSE_PRODUCT_IMAGE_DIR: path.join(root, '.preflight-images'),
  WAREHOUSE_DAILY_BACKUP_ENABLED: 'false',
  PORT: '0'
};
const script = "const app=require('./server');const server=app.startServer();server.once('listening',()=>process.stdout.write('READY '+server.address().port+'\\n'));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));";
const child = spawn(process.execPath, ['-e', script], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', error = '', finished = false;
const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
function cleanup() {
  for (const name of ['.preflight-data.json', '.preflight-data.json.attachments', '.preflight-protection', '.preflight-daily', '.preflight-images']) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}
function done(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  child.kill('SIGTERM');
  cleanup();
  if (message) process.stderr.write(message + '\n');
  if (code) process.stderr.write(error.slice(-4000) + '\n');
  process.exitCode = code;
}
child.stdout.on('data', chunk => {
  output += chunk;
  const match = output.match(/READY (\d+)/);
  if (!match) return;
  const request = http.request({ host: '127.0.0.1', port: Number(match[1]), path: '/api/auth/guest', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2' } }, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => {
      try {
        const json = JSON.parse(body);
        if (response.statusCode !== 200 || !json.data?.token) throw new Error('guest contract failed');
        done(0, '');
      } catch (exception) { done(1, exception.message); }
    });
  });
  request.on('error', exception => done(1, exception.message));
  request.end('{}');
});
child.stderr.on('data', chunk => { error += chunk; });
child.on('exit', code => { if (!finished) done(code || 1, 'preflight process exited'); });
