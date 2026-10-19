const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const execFileAsync = promisify(execFile);
const { createDailyBackup, scheduledDay, nextScheduledAt, readSnapshot } = require('./daily-backup');
const LIMIT = 65536, DAY = 86400000;
const INITIAL = Date.parse('2026-10-19T04:00:00Z');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fakeDb(id = 'one') {
  let count = 0, validations = 0, failure = null, extra = '';
  const db = {
    revision: () => 7,
    backupData(options) {
      count++; db.lastOptions = options;
      if (failure) throw new Error(failure);
      return { id, extra, products: [], ledger: [], _collaboration: { revision: 7 } };
    },
    validateBackup(data) { validations++; if (!data || !Array.isArray(data.products) || !Array.isArray(data.ledger) || data.id === 'invalid') throw new Error('invalid business data'); }
  };
  return { db, count: () => count, validations: () => validations, fail: value => { failure = value; }, extra: value => { extra = value; } };
}
function fixture(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-daily-backup-'));
  const directory = path.join(root, 'private', 'daily'), errors = [], warnings = [];
  const clock = { value: INITIAL }, fake = fakeDb();
  const options = { directory, maxBytes: LIMIT, env: {}, now: () => clock.value, logger: { error: (...args) => errors.push(args.join(' ')), warn: (...args) => warnings.push(args.join(' ')) }, ...config };
  const service = createDailyBackup(fake.db, options);
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, clock, fake, options, service, errors, warnings, at: day => path.join(directory, `daily-${day}.json.gz`) };
}
function files(directory) { return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^daily-.*\.json\.gz$/.test(name)).sort() : []; }
function writeSnapshot(directory, day, changes = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const data = { id: day, products: [], ledger: [], _collaboration: { revision: 7 } };
  const payload = { format: 'warehouse-daily-v1', scheduledDay: day, exportedAt: `${day}T04:00:00.000Z`, revision: 7, sha256: digest(data), data, ...changes };
  const target = path.join(directory, `daily-${day}.json.gz`);
  fs.writeFileSync(target, zlib.gzipSync(JSON.stringify(payload)));
  return target;
}
test('daily schedule follows Shanghai 01:59/02:00 boundary independently of host timezone', () => {
  const before = Date.parse('2026-10-18T17:59:59.999Z'), at = before + 1;
  assert.equal(scheduledDay(before), '2026-10-18');
  assert.equal(scheduledDay(at), '2026-10-19');
  assert.equal(nextScheduledAt(before), '2026-10-18T18:00:00.000Z');
  assert.equal(nextScheduledAt(at), '2026-10-19T18:00:00.000Z');
  assert.equal(scheduledDay(Date.parse('2026-10-18T16:00:00Z'), 0), '2026-10-19');
  assert.equal(scheduledDay(Date.parse('2026-10-19T14:59:59Z'), 23), '2026-10-18');
  assert.equal(scheduledDay(Date.parse('2026-10-19T15:00:00Z'), 23), '2026-10-19');
});
test('same process shares its running promise and same-day runs preserve the first snapshot', async t => {
  const f = fixture(t), first = f.service.runDue(), second = f.service.runDue();
  assert.equal(first, second);
  assert.equal(await first, true);
  const target = f.at('2026-10-19'), bytes = fs.readFileSync(target), stat = fs.statSync(target);
  assert.equal(f.fake.count(), 1);
  assert.deepEqual(f.fake.db.lastOptions, { includeAttachments: true, maxBytes: LIMIT - 2048 });
  assert.equal(await f.service.runDue(), false);
  assert.equal(f.fake.count(), 1);
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.equal(fs.statSync(target).mtimeMs, stat.mtimeMs);
  const status = await f.service.getStatus();
  assert.equal(status.verified, true);
  assert.equal(status.lastSuccessAt, new Date(INITIAL).toISOString());
  assert.equal(status.lastError, null);
  assert.equal((await f.service.latest()).data.id, 'one');
  assert.equal(fs.readdirSync(f.directory).some(name => name.includes('.tmp-')), false);
});
test('pre-02:00 run creates previous due slot and 02:00 creates the new due slot', async t => {
  const f = fixture(t);
  f.clock.value = Date.parse('2026-10-18T17:59:59.999Z');
  await f.service.runDue();
  assert.deepEqual(files(f.directory), ['daily-2026-10-18.json.gz']);
  f.clock.value++; await f.service.runDue();
  assert.deepEqual(files(f.directory), ['daily-2026-10-18.json.gz', 'daily-2026-10-19.json.gz']);
});
test('restart verifies files without trusting status and downtime backfills only the latest due slot', async t => {
  const f = fixture(t); await f.service.runDue();
  fs.unlinkSync(path.join(f.directory, 'status.json'));
  const restartedFake = fakeDb('restarted'), restarted = createDailyBackup(restartedFake.db, f.options);
  assert.equal(restarted.status().verified, false, 'advisory success is not trusted');
  assert.equal((await restarted.getStatus()).verified, true);
  assert.equal(await restarted.runDue(), false);
  assert.equal(restartedFake.count(), 0);
  f.clock.value += 4 * DAY;
  assert.equal(await restarted.runDue(), true);
  assert.deepEqual(files(f.directory), ['daily-2026-10-19.json.gz', 'daily-2026-10-23.json.gz']);
  assert.equal(restartedFake.count(), 1);
  await restarted.stop();
});
test('success stored in status.json alone cannot mark an absent snapshot verified', async t => {
  const f = fixture(t); fs.mkdirSync(f.directory, { recursive: true });
  fs.writeFileSync(path.join(f.directory, 'status.json'), JSON.stringify({ lastSuccessAt: new Date(INITIAL).toISOString(), lastDay: '2026-10-19', failed: false }));
  const restarted = createDailyBackup(f.fake.db, f.options);
  assert.equal((await restarted.getStatus()).verified, false);
  assert.equal(await restarted.runDue(), true);
  assert.equal((await restarted.getStatus()).verified, true);
  fs.writeFileSync(path.join(f.directory, 'status.json'), '{');
  const afterBrokenStatus = createDailyBackup(f.fake.db, f.options);
  assert.equal((await afterBrokenStatus.getStatus()).verified, true);
  assert.equal(await afterBrokenStatus.runDue(), false);
});
test('two instances publish one verified winner and never rewrite it later', async t => {
  const f = fixture(t), otherFake = fakeDb('other'), other = createDailyBackup(otherFake.db, f.options);
  await Promise.all([f.service.runDue(), other.runDue()]);
  assert.equal(files(f.directory).length, 1);
  const target = f.at('2026-10-19'), winner = await readSnapshot(target, LIMIT), before = fs.readFileSync(target);
  assert.ok(['one', 'other'].includes(winner.payload.data.id));
  assert.equal((await f.service.latest()).data.id, winner.payload.data.id);
  assert.equal((await other.latest()).data.id, winner.payload.data.id);
  await Promise.all([f.service.runDue(), other.runDue()]);
  assert.deepEqual(fs.readFileSync(target), before);
  assert.equal(fs.readdirSync(f.directory).some(name => name.includes('.tmp-')), false);
});
test('independent child processes publish a single immutable same-day winner', async t => {
  const f = fixture(t), modulePath = require.resolve('./daily-backup');
  const child = `const {createDailyBackup}=require(process.argv[1]);const fs=require('fs');const id=process.argv[3];const data={id,products:[],ledger:[],_collaboration:{revision:7}};const db={revision:()=>7,backupData:()=>data,validateBackup:x=>{if(!Array.isArray(x.products))throw Error('invalid')}};const service=createDailyBackup(db,{directory:process.argv[2],env:{},maxBytes:65536,now:()=>${INITIAL},logger:{warn(){},error(e){throw Error(String(e))}}});service.runDue().then(async()=>{const latest=await service.latest();process.stdout.write(JSON.stringify({id:latest.data.id,status:await service.getStatus()}));}).catch(e=>{process.stderr.write(e.stack);process.exitCode=1});`;
  const run = id => execFileAsync(process.execPath, ['-e', child, modulePath, f.directory, id], { timeout: 15000, windowsHide: true });
  const results = await Promise.all([run('child-a'), run('child-b')]);
  const parsed = results.map(result => JSON.parse(result.stdout));
  assert.equal(parsed[0].id, parsed[1].id);
  assert.equal(parsed[0].status.verified, true);
  assert.equal(parsed[1].status.verified, true);
  assert.equal(files(f.directory).length, 1);
  const before = fs.readFileSync(f.at('2026-10-19'));
  assert.equal(JSON.parse((await run('child-c')).stdout).id, parsed[0].id);
  assert.deepEqual(fs.readFileSync(f.at('2026-10-19')), before);
  assert.equal(fs.readdirSync(f.directory).some(name => name.includes('.tmp-')), false);
});
test('retention counts only verified due snapshots and ignores damaged and future files', async t => {
  const f = fixture(t, { env: { WAREHOUSE_DAILY_BACKUP_KEEP: '2' } });
  writeSnapshot(f.directory, '2026-10-15'); writeSnapshot(f.directory, '2026-10-16'); writeSnapshot(f.directory, '2026-10-17');
  fs.writeFileSync(f.at('2026-10-18'), 'broken-past');
  fs.writeFileSync(f.at('2099-01-01'), 'broken-future');
  writeSnapshot(f.directory, '2098-01-01');
  await f.service.runDue();
  assert.deepEqual(files(f.directory), ['daily-2026-10-17.json.gz', 'daily-2026-10-18.json.gz', 'daily-2026-10-19.json.gz', 'daily-2098-01-01.json.gz', 'daily-2099-01-01.json.gz']);
  assert.equal((await f.service.latest()).data.id, 'one');
  assert.equal(fs.readFileSync(f.at('2026-10-18'), 'utf8'), 'broken-past');
  assert.equal(fs.readFileSync(f.at('2099-01-01'), 'utf8'), 'broken-future');
});
test('restart after file publication repairs stale failure status and finishes retention without rewriting data', async t => {
  const f = fixture(t, { env: { WAREHOUSE_DAILY_BACKUP_KEEP: '2' } });
  writeSnapshot(f.directory, '2026-10-16'); writeSnapshot(f.directory, '2026-10-17'); writeSnapshot(f.directory, '2026-10-18');
  const target = writeSnapshot(f.directory, '2026-10-19'), before = fs.readFileSync(target);
  fs.writeFileSync(path.join(f.directory, 'status.json'), JSON.stringify({ lastAttemptAt: '2026-10-19T03:00:00.000Z', failed: true, retryAt: INITIAL - 1 }));
  const restarted = createDailyBackup(f.fake.db, f.options);
  assert.equal(await restarted.runDue(), false, 'already published snapshot should not be regenerated');
  assert.equal(f.fake.count(), 0);
  assert.equal(restarted.status().lastError, null);
  assert.equal(restarted.status().nextRetryAt, null);
  assert.deepEqual(fs.readFileSync(target), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'status.json'), 'utf8')).failed, false);
  assert.deepEqual(files(f.directory), ['daily-2026-10-18.json.gz', 'daily-2026-10-19.json.gz']);
});
test('truncated gzip and invalid hash cannot claim success or overwrite damaged originals', async t => {
  for (const kind of ['gzip', 'hash']) {
    const f = fixture(t);
    writeSnapshot(f.directory, '2026-10-18');
    if (kind === 'gzip') { writeSnapshot(f.directory, '2026-10-19'); const bytes = fs.readFileSync(f.at('2026-10-19')); fs.writeFileSync(f.at('2026-10-19'), bytes.subarray(0, 10)); }
    else writeSnapshot(f.directory, '2026-10-19', { sha256: '0'.repeat(64) });
    const before = fs.readFileSync(f.at('2026-10-19'));
    assert.equal(await f.service.runDue(), false);
    assert.equal(f.fake.count(), 0);
    assert.notEqual(f.service.status().lastError, null);
    assert.equal(f.service.status().lastSuccessAt, null);
    const checked = await f.service.getStatus();
    assert.equal(checked.verified, true, 'last known good old backup remains available');
    assert.equal(checked.lastSuccessAt, '2026-10-18T04:00:00.000Z');
    assert.notEqual(checked.lastError, null);
    assert.equal((await f.service.latest()).data.id, '2026-10-18');
    assert.deepEqual(fs.readFileSync(f.at('2026-10-19')), before);
  }
});
test('corruption after successful verification is detected by file signature recheck', async t => {
  const f = fixture(t); await f.service.runDue();
  assert.equal((await f.service.getStatus()).verified, true);
  fs.writeFileSync(f.at('2026-10-19'), Buffer.from('truncated'));
  const status = await f.service.getStatus();
  assert.equal(status.verified, false);
  assert.equal(status.lastSuccessAt, null);
  assert.notEqual(status.lastError, null);
  assert.equal(await f.service.runDue(), false);
  assert.equal(f.fake.count(), 1);
  await assert.rejects(f.service.latest(), /没有可用的每日备份/);
});
test('failed backup retries after fifteen minutes and clears error and retry state on success', async t => {
  const f = fixture(t); f.fake.fail('missing photo');
  assert.equal(await f.service.runDue(), false);
  assert.equal(f.fake.count(), 1);
  assert.equal(f.service.status().nextRetryAt, new Date(INITIAL + 15 * 60000).toISOString());
  f.fake.fail(null); f.clock.value += 15 * 60000 - 1;
  assert.equal(await f.service.runDue(), false); assert.equal(f.fake.count(), 1);
  f.clock.value++; assert.equal(await f.service.runDue(), true);
  assert.equal(f.fake.count(), 2);
  assert.equal(f.service.status().lastError, null); assert.equal(f.service.status().nextRetryAt, null);
  assert.equal(f.service.status().verified, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'status.json'), 'utf8')).failed, false);
});
test('restart retains pending retry delay and then succeeds without duplicate daily snapshots', async t => {
  const f = fixture(t); f.fake.fail('disk'); await f.service.runDue();
  const nextFake = fakeDb('restart'), next = createDailyBackup(nextFake.db, f.options);
  assert.notEqual(next.status().lastError, null);
  assert.equal(await next.runDue(), false); assert.equal(nextFake.count(), 0);
  f.clock.value += 15 * 60000;
  assert.equal(await next.runDue(), true);
  assert.equal(nextFake.count(), 1); assert.equal(next.status().nextRetryAt, null);
});
test('size overflow and invalid business data preserve earlier good backups and do not publish', async t => {
  const f = fixture(t, { maxBytes: 4096 });
  const old = writeSnapshot(f.directory, '2026-10-18'), bytes = fs.readFileSync(old);
  f.fake.extra('x'.repeat(5000));
  assert.equal(await f.service.runDue(), false);
  assert.equal(fs.existsSync(f.at('2026-10-19')), false);
  assert.deepEqual(fs.readFileSync(old), bytes);
  assert.equal((await f.service.getStatus()).lastSuccessAt, '2026-10-18T04:00:00.000Z');
  const invalid = fakeDb('invalid'), directory = path.join(f.root, 'invalid');
  const service = createDailyBackup(invalid.db, { ...f.options, directory });
  assert.equal(await service.runDue(), false);
  assert.equal(files(directory).length, 0);
});
test('readSnapshot rejects over-limit decompression and revision mismatch', async t => {
  const f = fixture(t);
  const large = writeSnapshot(f.directory, '2026-10-18', { data: { extra: 'x'.repeat(5000) } });
  await assert.rejects(readSnapshot(large, 1000));
  const mismatch = writeSnapshot(f.directory, '2026-10-19', { revision: 8 });
  await assert.rejects(readSnapshot(mismatch, LIMIT), /版本不一致/);
});
test('correct container hash cannot bypass business validation or filename date association', async t => {
  for (const kind of ['business', 'date']) {
    const f = fixture(t);
    if (kind === 'business') {
      const data = { id: 'invalid', products: [], ledger: [], _collaboration: { revision: 7 } };
      writeSnapshot(f.directory, '2026-10-19', { data, sha256: digest(data) });
    } else writeSnapshot(f.directory, '2026-10-19', { scheduledDay: '2026-10-18' });
    const original = fs.readFileSync(f.at('2026-10-19'));
    assert.equal((await f.service.getStatus()).verified, false);
    assert.equal(await f.service.runDue(), false);
    assert.equal(f.fake.count(), 0);
    assert.deepEqual(fs.readFileSync(f.at('2026-10-19')), original);
    await assert.rejects(f.service.latest(), /没有可用的每日备份/);
  }
});
test('disabled service never starts or writes and stop drains in-flight work', async t => {
  const disabled = fixture(t, { env: { WAREHOUSE_DAILY_BACKUP_ENABLED: 'false' } });
  disabled.service.start();
  assert.equal(disabled.service.status().active, false);
  assert.equal(disabled.service.status().nextScheduledAt, null);
  assert.equal(await disabled.service.runDue(), false);
  assert.equal(disabled.fake.count(), 0);
  assert.equal(fs.existsSync(disabled.directory), false);
  const f = fixture(t); f.service.start(); f.service.start();
  assert.equal(f.service.status().active, true);
  assert.equal(f.service.status().nextScheduledAt, '2026-10-19T18:00:00.000Z');
  await f.service.stop();
  assert.equal(f.fake.count(), 1);
  assert.equal(f.service.status().active, false); assert.equal(f.service.status().running, false);
  assert.equal(f.service.status().nextScheduledAt, null);
  assert.equal(files(f.directory).length, 1);
  await f.service.stop();
});
test('public-root backup paths are refused without writing files', async t => {
  const f = fixture(t), root = path.join(f.root, 'web');
  for (const directory of [root, path.join(root, 'daily')]) {
    const service = createDailyBackup(f.fake.db, { ...f.options, directory, env: { WAREHOUSE_WEB_ROOT: root } });
    service.start();
    assert.equal(service.status().active, false);
    assert.match(service.status().lastError, /公开网页目录之外/);
    assert.equal(await service.runDue(), false);
    assert.equal(fs.existsSync(directory), false);
    assert.equal((await service.getStatus()).verified, false);
  }
  const defaultPublic = path.join(__dirname, 'public', `daily-test-refused-${process.pid}`);
  const service = createDailyBackup(f.fake.db, { ...f.options, directory: defaultPublic });
  assert.equal(await service.runDue(), false);
  assert.equal(fs.existsSync(defaultPublic), false);
  assert.equal(f.fake.count(), 0);
});
