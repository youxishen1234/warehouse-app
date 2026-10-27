 'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function request(port, method, route, body, idempotencyKey, expectedRevision) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers = {
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...(expectedRevision !== undefined && method !== 'GET' ? { 'If-Match': String(expectedRevision) } : {})
    };
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers }, response => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { content += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, revision: response.headers['x-warehouse-revision'], body: JSON.parse(content) });
        } catch { reject(new Error(`billing verifier received invalid JSON (${response.statusCode})`)); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('billing verifier request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

function requireSuccess(response, label) {
  if (response.status !== 200 || response.body?.success !== true) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }
  return response.body.data;
}

function key() { return `billing-verify-${crypto.randomUUID()}`; }

async function verify() {
  const working = process.cwd();
  if (!fs.existsSync(path.join(working, 'server.js'))
    || !fs.existsSync(path.join(working, 'db.js'))
    || !fs.existsSync(path.join(working, 'team.js'))) {
    throw new Error('billing verifier must run from the deployed backend working directory');
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-billing-acceptance-'));
  const childEnv = {
    ...process.env,
    WAREHOUSE_DATA_FILE: path.join(sandbox, 'data.json'),
    WAREHOUSE_BACKUP_DIR: path.join(sandbox, 'backups'),
    WAREHOUSE_DAILY_BACKUP_DIR: path.join(sandbox, 'daily-backups'),
    WAREHOUSE_PRODUCT_IMAGE_DIR: path.join(sandbox, 'product-images'),
    WAREHOUSE_DIMENSIONS_FILE: path.join(sandbox, 'customer-dimensions.json'),
    WAREHOUSE_REMOTE_PRINT_FILE: path.join(sandbox, 'remote-print.json'),
    WAREHOUSE_AI_CONFIG_FILE: path.join(sandbox, 'ai-connection.json'),
    WAREHOUSE_AI_SPEECH_DIR: path.join(sandbox, 'ai-speech'),
    WAREHOUSE_DAILY_BACKUP_ENABLED: 'false',
    NODE_ENV: 'test',
    PORT: '0'
  };
  fs.writeFileSync(childEnv.WAREHOUSE_DATA_FILE, JSON.stringify({
    products: [], customers: [], suppliers: [], transactions: [], ledger: [],
    orders: [], order_events: [], stocktakes: [], delivery_notes: [], _meta: { schemaVersion: 1 }
  }));
  fs.writeFileSync(childEnv.WAREHOUSE_DIMENSIONS_FILE, JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    customers: [],
    theme: { title: '验收', accent: '#468cfb', bg: '#101319', card: '#202630' }
  }));
  for (const directory of [childEnv.WAREHOUSE_BACKUP_DIR, childEnv.WAREHOUSE_DAILY_BACKUP_DIR, childEnv.WAREHOUSE_PRODUCT_IMAGE_DIR]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const start = "const app=require('./server');const server=app.startServer();server.once('listening',()=>process.stdout.write('BILLING_READY '+server.address().port+'\\n'));";
  const child = spawn(process.execPath, ['-e', start], { cwd: working, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let failure = '';
  let port;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isolated backend did not start in time')), 15000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/BILLING_READY (\d+)/);
      if (match) { clearTimeout(timer); port = Number(match[1]); resolve(); }
    });
    child.stderr.on('data', chunk => { failure += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      if (!port) {
        clearTimeout(timer);
        reject(new Error(`isolated backend exited before startup (${code}): ${failure.slice(-1000)}`));
      }
    });
  });

  try {
    await ready;
    const health = await request(port, 'GET', '/api/health');
    requireSuccess(health, 'backend health');
    let revision = health.revision || '0';
    const call = async (method, route, body, idempotencyKey) => {
      const response = await request(port, method, route, body, idempotencyKey, revision);
      if (response.revision !== undefined) revision = response.revision;
      return response;
    };
    const suffix = crypto.randomUUID();
    const customer = requireSuccess(await call('POST', '/api/customers', { name: `验收客户-${suffix}` }, key()), 'fixture customer creation');
    const product = requireSuccess(await call('POST', '/api/products', {
      name: `验收纸箱-${suffix}`, category: '纸箱', specification: '20×10×5cm', material: 'K=K',
      unit: '个', price: 0, stock: 0
    }, key()), 'fixture product creation');
    const specs = [300, 200].map(price => ({
      id: `billing-${price}`, goods: '验收纸箱', specification: '20×10×5cm', material: 'K=K', unit: '个', price
    }));
    requireSuccess(await call('PUT', `/api/customers/${customer.id}`, { specs }, key()), 'fixture customer quotation');

    const inboundProductIds = [];
    for (const price of [300, 200]) {
      const receipt = requireSuccess(await call('POST', '/api/delivery-notes', {
        source_type: 'production', party_type: 'customer', customer_id: customer.id,
        work_order_no: `VERIFY-${price}-${suffix}`,
        lines: [{ product_id: null, quantity: 1, delivered_qty: 1, customer_spec_id: `billing-${price}`, specification: '20×10×5cm' }]
      }, key()), `production receipt at ${price}`);
      inboundProductIds.push(receipt.lines[0]?.product_id);
    }
    if (!inboundProductIds[0] || new Set(inboundProductIds).size !== 1) {
      throw new Error('customer specifications must resolve one reusable customer-owned stock SKU');
    }
    const inboundProductId = inboundProductIds[0];

    let currentCustomer = requireSuccess(await call('GET', `/api/customers/${customer.id}`), 'customer balance after production receipts');
    if (Math.abs(Number(currentCustomer.debt) - 500) > 0.005) throw new Error(`production receipts should create 500 receivable, got ${currentCustomer.debt}`);

    requireSuccess(await call('POST', `/api/customers/${customer.id}/settlement`, { amount: 100, remark: 'isolated release acceptance' }, key()), 'customer collection');
    currentCustomer = requireSuccess(await call('GET', `/api/customers/${customer.id}`), 'customer balance after collection');
    if (Math.abs(Number(currentCustomer.debt) - 400) > 0.005) throw new Error(`100 collection should reduce 500 receivable to 400, got ${currentCustomer.debt}`);

    const outbound = requireSuccess(await call('POST', '/api/stock/out/batch', {
      customer_id: customer.id, operator: 'billing-release-verification',
      lines: [{ product_id: inboundProductId, quantity: 2, unit: '个', unit_price: 250, specification: '20×10×5cm' }]
    }, key()), 'shipment');
    const transaction = outbound?.transactions?.[0]?.transaction;
    if (!transaction || Number(transaction.receivable_amount) !== 0) {
      throw new Error('shipment must allocate the previously billed production quantity without new receivable');
    }
    currentCustomer = requireSuccess(await call('GET', `/api/customers/${customer.id}`), 'customer balance after shipment');
    if (Math.abs(Number(currentCustomer.debt) - 400) > 0.005) throw new Error(`shipment duplicated receivable; expected 400, got ${currentCustomer.debt}`);

    const ledger = requireSuccess(await call('GET', `/api/ledger?party_type=customer&party_id=${customer.id}`), 'customer ledger');
    const rows = Array.isArray(ledger) ? ledger : ledger.items || [];
    const receivables = rows.filter(entry => entry.type === 'receivable');
    if (receivables.length !== 2 || Math.abs(receivables.reduce((sum, row) => sum + Number(row.amount), 0) - 500) > 0.005) {
      throw new Error('customer ledger must contain only the 300 and 200 production receivables');
    }

    process.stdout.write(JSON.stringify({ verified: true, productionReceivable: 500, collected: 100, finalDebt: 400, shipmentReceivable: 0 }) + '\n');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (require.main === module) {
  verify().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { verify };
