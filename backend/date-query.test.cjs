const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('local calendar end dates follow DST transitions instead of fixed 24-hour math', () => {
  const modulePath = path.join(__dirname, 'date-query.js');
  const script = [
    `const { parseDateQuery } = require(${JSON.stringify(modulePath)});`,
    "const start = parseDateQuery(process.argv[1]);",
    "const end = parseDateQuery(process.argv[1], true);",
    "process.stdout.write(JSON.stringify({ duration: end - start + 1, start, end }));"
  ].join('\n');
  const run = date => {
    const result = spawnSync(process.execPath, ['-e', script, date], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run('2026-03-08').duration, 23 * 60 * 60 * 1000);
  assert.equal(run('2026-11-01').duration, 25 * 60 * 60 * 1000);
});

test('numeric timestamp bounds retain their legacy inclusive expansion', () => {
  const { parseDateQuery, DAY_MS } = require('./date-query');
  const timestamp = 1760000000000;
  assert.equal(parseDateQuery(String(timestamp)), timestamp);
  assert.equal(parseDateQuery(String(timestamp), true), timestamp + DAY_MS - 1);
});
