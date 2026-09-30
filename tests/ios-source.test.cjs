const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createSource } = require('../scripts/create-ios-source.cjs');

test('LCSign plain source points to the published IPA with stable identity', () => {
  const metadata = { name: '曙光', version: '1.1.4', build: '137', bundleId: 'com.warehouse.app', sizeBytes: 8710065 };
  const source = createSource(metadata, '2026-09-30T16:00:00Z');
  assert.equal(source.sourceURL, 'https://youxishen.online/download/source.json');
  assert.equal(source.apps.length, 1);
  assert.equal(source.apps[0].size, String(metadata.sizeBytes));
  assert.equal(source.apps[0].lock, '0');
  assert.equal(source.apps[0].version, metadata.version);
  assert.equal(source.apps[0].buildVersion, metadata.build);
  assert.equal(new URL(source.apps[0].downloadURL).searchParams.get('build'), metadata.build);
  const next = createSource({ ...metadata, build: '138' });
  assert.equal(next.identifier, source.identifier);
  assert.notEqual(next.apps[0].downloadURL, source.apps[0].downloadURL);
  assert.throws(() => createSource({ ...metadata, sizeBytes: 0 }), /Invalid/);
});

test('both iOS upload branches include the source and publish it after the IPA', () => {
  const workflow = fs.readFileSync('.github/workflows/build-ios.yml', 'utf8');
  assert.equal(workflow.split('/tmp/shuguang-source.json /tmp/shuguang-download.html').length - 1, 2);
  assert.ok(workflow.includes('cp release/download/source.json /tmp/shuguang-source.json'));
  const publish = fs.readFileSync('scripts/publish-ios-files.sh', 'utf8');
  assert.ok(publish.indexOf('mv "$root/download/source.json.new"') > publish.indexOf('mv "$root/download/ipa.json.new"'));
});
