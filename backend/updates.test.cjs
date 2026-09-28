const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const install = require('./team');
const updates = require('./updates');

test('hot-update report contract accepts download attempts', () => {
  assert.ok(updates.REPORT_EVENTS.includes('download_attempt'));
});

test('hot-update event messages redact credentials, query tokens, filesystem paths and line breaks', () => {
  const originalAppend = fs.appendFileSync;
  const originalLog = console.log;
  let persisted = '';
  let printed = '';
  fs.appendFileSync = (_file, contents) => { persisted += String(contents); };
  console.log = message => { printed += String(message); };
  try {
    const result = updates.logEvent({
      event: 'download_failed',
      message: 'Authorization: Bearer super-secret-token token=another-secret https://host.example/update?t=private C:\\Users\\MSI\\secret.zip\nsecond-line'
    });
    assert.doesNotMatch(result.message, /super-secret-token|another-secret|private|C:\\Users/);
    assert.match(result.message, /https:\/\/host\.example\/update\?\[REDACTED\]/);
    assert.match(result.message, /\[PATH\]/);
    assert.doesNotMatch(result.message, /\r|\n/);
    assert.doesNotMatch(persisted, /super-secret-token|another-secret|private|C:\\Users/);
    assert.doesNotMatch(printed, /super-secret-token|another-secret|private|C:\\Users/);
    assert.doesNotMatch(printed, /\nsecond-line/);
  } finally {
    fs.appendFileSync = originalAppend;
    console.log = originalLog;
  }
});

test('hot-update stats recent parameter is bounded instead of silently coercing invalid values', () => {
  assert.equal(updates.parseRecent(undefined), 50);
  assert.equal(updates.parseRecent('1'), 1);
  assert.equal(updates.parseRecent(String(updates.RECENT_MAX)), updates.RECENT_MAX);
  for (const value of ['0', '-1', '201', '1.5', 'abc', '', '9999', [], {}, true]) {
    assert.throws(() => updates.parseRecent(value), error => error?.status === 400 && /recent/.test(error.message));
  }
});

test('hot-update manifests reject unsafe versions, URLs and mismatched integrity metadata', () => {
  const digest = 'a'.repeat(64);
  const valid = {
    version: '2026.09.27-test',
    url: 'www.zip',
    size: 12,
    sha256: digest,
    integrity: { algorithm: 'sha256', value: digest }
  };
  assert.equal(updates.validateManifest(valid).integrity.value, digest);
  for (const manifest of [
    { ...valid, version: '' },
    { ...valid, version: '../release' },
    { ...valid, url: '../accounts.json' },
    { ...valid, url: '/etc/passwd' },
    { ...valid, sha256: 'not-a-digest' },
    { ...valid, size: -1 },
    { ...valid, integrity: { algorithm: 'sha1', value: digest } },
    { ...valid, integrity: { algorithm: 'sha256', value: 'b'.repeat(64) } },
    { ...valid, publishedAt: { year: 2026 } },
    { ...valid, releaseNotes: 'x'.repeat(2001) },
    { ...valid, forceUpdate: 'false' },
    { ...valid, minNativeVersion: { version: '1.0.0' } },
    { ...valid, sha256: undefined },
    { ...valid, integrity: undefined }
  ]) {
    assert.throws(() => updates.validateManifest(manifest), /manifest/);
  }
  const extendedIntegrity = updates.validateManifest({ ...valid, integrity: { algorithm: 'sha256', value: digest, secretPath: 'must-not-leak' } });
  assert.deepEqual(extendedIntegrity.integrity, { algorithm: 'sha256', value: digest });
});

test('hot-update stats enforces the recent bound for direct service callers', () => {
  assert.throws(() => updates.stats(0), error => error?.status === 400);
  assert.throws(() => updates.stats(201), error => error?.status === 400);
  assert.throws(() => updates.stats([]), error => error?.status === 400);
  assert.ok(Array.isArray(updates.stats(1).recent));
});

test('hot-update stats exposes only validated release integrity metadata', () => {
  const directory = path.join(__dirname, 'public', 'appupdate');
  const manifestPath = path.join(directory, 'manifest.json');
  const existed = fs.existsSync(manifestPath);
  const previous = existed ? fs.readFileSync(manifestPath) : null;
  const digest = 'c'.repeat(64);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ version: '20260927123456', url: 'www.zip', size: 42, sha256: digest, integrity: { algorithm: 'sha256', value: digest }, secretPath: 'must-not-leak' }));
  try {
    const result = updates.stats(1);
    assert.deepEqual(result.latest, { version: '20260927123456', publishedAt: '', url: 'www.zip', size: 42, sha256: digest, integrity: { algorithm: 'sha256', value: digest } });
    assert.equal(Object.prototype.hasOwnProperty.call(result.latest, 'secretPath'), false);
  } finally {
    if (existed) fs.writeFileSync(manifestPath, previous);
    else {
      fs.unlinkSync(manifestPath);
      try { fs.rmdirSync(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
    }
  }
});

test('hot-update check query rejects arrays, scripts, unsupported platforms and malformed cache busts', () => {
  assert.deepEqual(updates.parseCheckQuery({ platform: 'ios', device_id: 'device-1', current: 'builtin', t: '1727000000000' }), { platform: 'ios', device_id: 'device-1', native_version: '', current: 'builtin' });
  for (const query of [{ platform: ['ios', 'android'] }, { platform: 'playstation' }, { device_id: { nested: 'x' } }, { current: '<script>alert(1)</script>' }, { t: 'now' }, { native_version: '\u0000' }]) assert.throws(() => updates.parseCheckQuery(query), error => error?.status === 400);
});

test('hot-update reports reject empty, nested and oversized payload fields', () => {
  assert.deepEqual(updates.parseReportPayload({ event: 'download_attempt', platform: 'ios', device_id: 'device-1' }), {
    event: 'download_attempt', device_id: 'device-1', platform: 'ios', native_version: '', current: '', from_version: '', to_version: '', message: ''
  });
  for (const body of [null, [], {}, { event: 'unknown' }, { event: 'downloaded', platform: 'playstation' }, { event: 'installed', message: 'x'.repeat(501) }, { event: 'installed', device_id: { nested: true } }, { event: 'installed', message: '<script>' }]) {
    assert.throws(() => updates.parseReportPayload(body), error => error?.status === 400);
  }
});

test('app download query accepts only a numeric cache bust', () => {
  assert.equal(updates.parseDownloadsQuery({}), '');
  assert.equal(updates.parseDownloadsQuery({ t: '1727000000000' }), '1727000000000');
  for (const query of [{ t: 'now' }, { t: ['1', '2'] }, { foo: 'bar' }, { redirect: '<script>' }]) {
    assert.throws(() => updates.parseDownloadsQuery(query), error => error?.status === 400);
  }
});

test('hot-update stats is reachable over HTTP behind the authenticated router', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-hot-update-http-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const password = 'Hot-update-http-password!';
  const previousAccounts = process.env.WAREHOUSE_ACCOUNTS_FILE;
  const previousStatsLimit = process.env.WAREHOUSE_HOTUPDATE_STATS_RATE_LIMIT;
  process.env.WAREHOUSE_HOTUPDATE_STATS_RATE_LIMIT = '3';
  const fakeDb = { revision: () => 0, stats: () => ({}) };
  const app = express();
  app.use(express.json());
  app.use('/api', install(fakeDb));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const unauthenticated = await fetch(origin + '/appupdate/stats?recent=1');
    assert.equal(unauthenticated.status, 200);
    const headers = {};

    const valid = await fetch(origin + '/appupdate/stats?recent=1', { headers });
    assert.equal(valid.status, 200);
    const validBody = await valid.json();
    assert.equal(validBody.success, true);
    assert.ok(validBody.data && Array.isArray(validBody.data.recent));
    assert.ok(validBody.data.recent.length <= 1);

    const invalid = await fetch(origin + '/appupdate/stats?recent=0', { headers });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.success, false);
    assert.match(invalidBody.message, /recent/);

    const limited = [];
    for (let index = 0; index < 4; index += 1) limited.push(await fetch(origin + '/appupdate/stats?recent=1', { headers: { ...headers, 'X-Warehouse-Device': 'stats-test-device' } }));
    const rateLimited = limited.find(response => response.status === 429);
    assert.ok(rateLimited, 'stats should be rate limited per source');
    assert.equal(rateLimited.headers.get('retry-after'), '60');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previousAccounts === undefined) delete process.env.WAREHOUSE_ACCOUNTS_FILE;
    if (previousStatsLimit === undefined) delete process.env.WAREHOUSE_HOTUPDATE_STATS_RATE_LIMIT;
    else process.env.WAREHOUSE_HOTUPDATE_STATS_RATE_LIMIT = previousStatsLimit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
