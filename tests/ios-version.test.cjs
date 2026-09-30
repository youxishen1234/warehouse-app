const test = require('node:test');
const assert = require('node:assert/strict');
const { versionForRun } = require('../scripts/ios-version.cjs');
const { createSource } = require('../scripts/create-ios-source.cjs');

test('visible iOS version increases with each build and stays stable for retries', () => {
  assert.equal(versionForRun(137), '1.1.4');
  assert.equal(versionForRun(138), '1.1.5');
  assert.equal(versionForRun(139), '1.1.6');
  assert.equal(versionForRun(138), versionForRun('138'));
  assert.throws(() => versionForRun(136));
  assert.throws(() => versionForRun(undefined));
  assert.throws(() => versionForRun('138x'));
  assert.equal(versionForRun(200, { baseVersion: '1.2.0', baseRunNumber: 200 }), '1.2.0');
});

test('software source displays the same visible version as the IPA metadata', () => {
  const version = versionForRun(138);
  const source = createSource({ name: '曙光', version, build: '138', bundleId: 'com.warehouse.app', sizeBytes: 100 });
  assert.equal(source.apps[0].version, '1.1.5');
  assert.equal(source.apps[0].buildVersion, '138');
});
