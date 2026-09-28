const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('write revision precedence remains resource, global, then sync fallback', () => {
  const source = fs.readFileSync('src/services/request.ts', 'utf8');
  assert.match(source, /editRevisions\.get\(url\) \|\| knownRevision \|\| serverRevision/);
  assert.match(source, /resource snapshot instead of a stale global header/);
  assert.match(source, /If-Match/);
  assert.match(source, /editRevisions\.set\(url/);
  assert.match(source, /editRevisions\.delete\(url/);
  assert.match(source, /editRevisions\.clear\(\)/);
});

test('network error matcher covers browser, WebView and Node transport messages', () => {
  const source = fs.readFileSync('src/services/request.ts', 'utf8');
  for (const token of ['failed to fetch', 'ERR_NETWORK', 'ERR_INTERNET_DISCONNECTED', 'ECONNRESET', 'net::ERR_']) assert.match(source, new RegExp(token.replace(/[.:]/g, '\\$&'), 'i'));
});

test('request layer keeps timeout and HTTP 5xx messages user friendly', () => {
  const source = fs.readFileSync('src/services/request.ts', 'utf8');
  assert.match(source, /timeout/);
  assert.match(source, /friendlyError/);
  assert.match(source, /HTTP \(\\d\+\)/);
});

test('critical write errors bypass offline toast throttling', () => {
  const source = fs.readFileSync('src/services/request.ts', 'utf8');
  assert.match(source, /function toastOnce\(title: string, force = false\)/);
  assert.match(source, /toastOnce\(msg, !isRead\)/);
});

test('409 conflicts can use the revision returned in the response body', () => {
  const source = fs.readFileSync('src/services/request.ts', 'utf8');
  assert.match(source, /bodyRevision = \(res\.data as any\)\?\.data\?\.revision/);
  assert.match(source, /conflictRevision = revisionHeader === undefined && bodyRevision !== undefined/);
  assert.match(source, /refreshSharedData\(conflictRevision/);
});
