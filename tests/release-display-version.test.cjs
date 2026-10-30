const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  nextDisplayVersion,
  readBaseline,
  writeGitHubEnv
} = require('../scripts/release-display-version.cjs');

test('release display versions start at 1.23 and advance by one minor version', () => {
  assert.equal(nextDisplayVersion({}), '1.23');
  assert.equal(nextDisplayVersion({ displayVersion: '1.23' }), '1.24');
  assert.equal(nextDisplayVersion({ displayVersion: '1.99' }), '1.100');
  assert.equal(nextDisplayVersion({ displayVersion: '2.7' }), '2.8');
  assert.throws(() => nextDisplayVersion({ displayVersion: '1.23.4' }), /major\.minor/);
});

test('release workflow writes both build and manifest display versions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-display-version-'));
  const baseline = path.join(directory, 'base-manifest.json');
  const githubEnv = path.join(directory, 'github-env');
  fs.writeFileSync(baseline, JSON.stringify({ displayVersion: '1.23' }));
  try {
    assert.deepEqual(readBaseline(baseline), { displayVersion: '1.23' });
    writeGitHubEnv(githubEnv, nextDisplayVersion(readBaseline(baseline)));
    assert.equal(fs.readFileSync(githubEnv, 'utf8'), 'TARO_APP_DISPLAY_VERSION=1.24\nHOTUPDATE_DISPLAY_VERSION=1.24\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
