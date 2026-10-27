const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localDate, BUSINESS_TIME_ZONE } = require('./stock-math');

test('business dates follow Asia/Shanghai across the UTC midnight boundary', () => {
  assert.equal(BUSINESS_TIME_ZONE, 'Asia/Shanghai');
  assert.equal(localDate(new Date('2026-10-27T15:59:59.999Z')), '2026-10-27');
  assert.equal(localDate(new Date('2026-10-27T16:00:00.000Z')), '2026-10-28');
  assert.equal(localDate(new Date('2026-12-31T16:00:00.000Z')), '2027-01-01');
});

test('business dates do not depend on the host time zone', () => {
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const script = [
    `const { localDate } = require(${JSON.stringify(path.join(__dirname, 'stock-math.js'))});`,
    "process.stdout.write(localDate(new Date('2026-10-27T16:00:00.000Z')));"
  ].join('\n');
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '2026-10-28');
  }
});
