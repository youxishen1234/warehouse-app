const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('transaction cleanup bounds idempotency receipts without deleting fresh retries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-receipt-retention-'));
  const dataFile = path.join(dir, 'data.json');
  const backupDir = path.join(dir, 'backups');
  const stale = {};
  for (let index = 0; index < 1000; index += 1) stale[`old-${index}:key`] = { fingerprint: `old-${index}`, data: { id: index }, time: Date.now() - 8 * 86400000 };
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [], _collaboration: {
    revision: 0, audit: [], receipts: { ...stale, 'fresh:key': { fingerprint: 'fresh-fingerprint', data: { id: 1 }, time: Date.now() } }
  } }));
  const env = { ...process.env, WAREHOUSE_DATA_FILE: dataFile, WAREHOUSE_BACKUP_DIR: backupDir };
  const script = `const db=require('./db'); const result=db.transact({id:'new-actor'},'new-key','new-fingerprint',String(db.revision()),'receipt cleanup test',()=>({id:2})); if(!result.data || db.receipt('fresh','key')===null || db.receipt('new-actor','new-key')===null || db.receipt('old-0','key')!==null) process.exit(2); const count=Object.keys(db.backupData()._collaboration.receipts).length; if(count!==2) process.exit(3); process.stdout.write('ok');`;
  try {
    assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: __dirname, env, encoding: 'utf8' }), 'ok');
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.deepEqual(Object.keys(saved._collaboration.receipts).sort(), ['fresh:key', 'new-actor:new-key']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
