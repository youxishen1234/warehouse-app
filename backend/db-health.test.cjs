const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('startup load reports dangling references without blocking startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-db-health-'));
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [{ id: 1, product_id: 404, type: 'out', quantity: 1, unit_price: 1, amount: 1 }], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: [] }));
  const script = "const db=require('./db'); process.stdout.write(JSON.stringify(db.health()));";
  try {
    const output = execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env: { ...process.env, WAREHOUSE_DATA_FILE: file }, encoding: 'utf8' });
    const health = JSON.parse(output.trim().split(/\r?\n/).pop());
    assert.equal(health.online, true);
    assert.equal(health.warningCount, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
