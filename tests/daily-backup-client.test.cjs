const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const sample = () => ({ enabled: true, active: true, timeZone: 'Asia/Shanghai', hour: 2, keepDays: 30, lastSuccessAt: '2026-10-18T18:00:00.000Z', lastAttemptAt: '2026-10-18T18:00:00.000Z', lastError: null, nextScheduledAt: '2026-10-19T18:00:00.000Z', nextRetryAt: null, running: false, location: 'server', verified: true });
function load(request) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync('src/services/daily-backup.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: id => { assert.equal(id, './request'); return { request }; } });
  return module.exports;
}

test('daily backup status always requests a fresh authenticated service read with a bounded timeout', async () => {
  const calls = [];
  const api = load(async options => { calls.push(options); return sample(); });
  assert.equal((await api.getDailyBackupStatus()).verified, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: '/api/backup/daily/status', method: 'GET', forceNetwork: true, timeout: 15000 }]);
});

test('latest daily backup uses fresh network and remains compatible with manual restore envelope', async () => {
  const calls = [];
  const envelope = { exportedAt: '2026-10-18T18:00:00.000Z', data: { products: [{ id: 1 }], ledger_attachment_files: { photo: 'fixture' } } };
  const api = load(async options => { calls.push(options); return envelope; });
  assert.deepEqual(await api.getLatestDailyBackup(), envelope);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: '/api/backup/daily/latest', method: 'GET', forceNetwork: true, timeout: 120000 }]);
});

test('undeployed, incomplete and invalid status responses never become enabled defaults', async () => {
  const bad = [null, {}, [], 'not deployed', { ...sample(), enabled: 'true' }, { ...sample(), hour: 24 }, { ...sample(), hour: -1 }, { ...sample(), keepDays: 0 }, { ...sample(), lastSuccessAt: 'broken' }, { ...sample(), nextRetryAt: undefined }, { ...sample(), location: 'device' }, { ...sample(), timeZone: 'UTC' }, { ...sample(), verified: undefined }];
  for (const value of bad) await assert.rejects(load(async () => value).getDailyBackupStatus(), /有效的每日备份状态/);
  await assert.rejects(load(async () => { throw new Error('未连接'); }).getDailyBackupStatus(), /未连接/);
  const disabled = await load(async () => ({ ...sample(), enabled: false, active: false, lastSuccessAt: null, verified: false })).getDailyBackupStatus();
  assert.equal(disabled.enabled, false);
});

test('malformed or empty backup responses are rejected before any download', async () => {
  for (const value of [null, {}, [], { exportedAt: 'invalid', data: {} }, { exportedAt: sample().lastSuccessAt, data: null }, { exportedAt: sample().lastSuccessAt, data: [] }]) {
    await assert.rejects(load(async () => value).getLatestDailyBackup(), /备份文件不完整/);
  }
});

test('server dates always display in Beijing time and never device local time', () => {
  const api = load(async () => sample());
  assert.equal(api.formatDailyBackupTime('2026-10-18T18:00:00.000Z'), '2026-10-19 02:00:00（北京时间）');
  assert.equal(api.formatDailyBackupTime('2026-10-19T02:00:00+08:00'), '2026-10-19 02:00:00（北京时间）');
  assert.equal(api.formatDailyBackupTime(null), '暂无');
  assert.equal(api.formatDailyBackupTime('bad date'), '暂无');
  assert.equal(api.formatDailyBackupTime('2026-10-19T02:00:00'), '暂无', 'ambiguous device-local timestamps are not trusted');
});

test('private daily downloads have no clipboard, storage or background-phone backup fallback', () => {
  const source = fs.readFileSync('src/components/BusinessForms/BackupSettings/daily-status.tsx', 'utf8');
  assert.doesNotMatch(source, /setClipboardData|writeText|localStorage|setStorageSync|setInterval/);
  assert.match(source, /aria-live='polite'/);
  assert(source.includes('current === requestId.current'));
  assert(source.includes('downloadBusy.current'));
});
