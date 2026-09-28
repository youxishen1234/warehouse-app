const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('load migrates legacy string timestamps to millisecond numbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-timestamp-migration-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  fs.writeFileSync(dataFile, JSON.stringify({
    products: [{ id: 1, name: '时间迁移商品', stock: 1, price: 2, safety_stock: 0, unit: '件', created_at: '2026-09-28T12:00:00.000Z', updated_at: '2026-09-28T12:00:01.000Z' }],
    customers: [], suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], delivery_notes: []
  }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir };
  try {
    const output = execFileSync(process.execPath, ['-e', "const db=require('./db'); const p=db.getProduct(1); process.stdout.write(JSON.stringify({created:typeof p.created_at,updated:typeof p.updated_at,createdValue:p.created_at,updatedValue:p.updated_at,warnings:db.health().warningCount}));"], { cwd: __dirname, env, encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.deepEqual(result, { created: 'number', updated: 'number', createdValue: 1790596800000, updatedValue: 1790596801000, warnings: 1 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
