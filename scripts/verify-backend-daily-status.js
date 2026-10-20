'use strict';

const http = require('node:http');

function request(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body || '';
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, response => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { content += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: content }));
    });
    request.setTimeout(15000, () => request.destroy(new Error('daily status verification timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

async function main() {
  const port = Number(process.env.BACKEND_ACCEPTANCE_PORT || process.env.PORT || 4000);
  const token = process.env.BACKEND_ACCEPTANCE_TOKEN;
  let sessionToken = token;
  if (!sessionToken) {
    const deadline = Date.now() + 15000;
    let session;
    do {
      try {
        session = await request(port, 'POST', '/api/auth/guest', {
          'Content-Type': 'application/json',
          'X-Request-Id': process.env.BACKEND_ACCEPTANCE_REQUEST || ''
        }, '{}');
        break;
      } catch (error) {
        if (error.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } while (Date.now() < deadline);
    if (session.status !== 200) throw new Error(`guest session HTTP ${session.status}: ${session.body.slice(0, 200)}`);
    const parsed = JSON.parse(session.body);
    sessionToken = parsed?.data?.token;
    if (!sessionToken) throw new Error('guest session did not return a token');
  }
  const response = await request(port, 'GET', '/api/backup/daily/status', {
    Authorization: `Bearer ${sessionToken}`,
    'X-Request-Id': process.env.BACKEND_ACCEPTANCE_REQUEST || ''
  });
  if (response.status !== 200) throw new Error(`daily status HTTP ${response.status}: ${response.body.slice(0, 200)}`);
  const result = JSON.parse(response.body);
  if (result.success !== true || !result.data || result.data.timeZone !== 'Asia/Shanghai') {
    throw new Error('daily status contract mismatch');
  }
  process.stdout.write(JSON.stringify({
    status: response.status,
    verified: result.data.verified,
    active: result.data.active,
    requestId: response.headers['x-request-id'] || ''
  }));
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
