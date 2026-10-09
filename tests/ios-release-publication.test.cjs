const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publishIOSRelease } = require('../scripts/publish-ios-release.cjs');
const commit = 'a'.repeat(40), tag = 'build-167';

test('missing simulator diagnostics cannot fail publication of an existing IPA', async () => {
  const calls = [], warnings = [];
  const result = await publishIOSRelease({ tag, commit, exists: name => name === 'ios/App/shuguang.ipa', run: args => calls.push(args), warn: message => warnings.push(message) });
  assert.deepEqual(result.assets, ['ios/App/shuguang.ipa']);
  assert.equal(result.missing.length, 3);
  assert.equal(warnings.length, 1);
  assert.deepEqual(calls.at(-1), ['release', 'upload', tag, 'ios/App/shuguang.ipa', '--clobber']);
});

test('existing diagnostics are uploaded and transient requests retry without losing the source commit', async () => {
  const calls = [], waits = [];
  let failed = false;
  const result = await publishIOSRelease({ tag, commit, exists: () => true, list: () => ['native-dock-step-home.png', 'unrelated.txt'], wait: async ms => waits.push(ms), warn() {}, run: args => {
    calls.push(args);
    if (args[1] === 'view') throw new Error('not found');
    if (args[1] === 'upload' && !failed) { failed = true; throw new Error('temporary transport failure'); }
  } });
  assert.equal(result.assets.length, 5);
  assert.deepEqual(result.missing, []);
  assert.equal(calls.find(args => args[1] === 'create')[4], commit);
  assert.deepEqual(waits, [10000]);
  assert.equal(calls.filter(args => args[1] === 'upload' && args[3] === 'ios/App/shuguang.ipa').length, 2);
});

test('missing IPA and permanent upload errors remain failures', async () => {
  let called = false;
  await assert.rejects(publishIOSRelease({ tag, commit, exists: () => false, run: () => { called = true; } }), /Required IPA/);
  assert.equal(called, false);
  let uploads = 0;
  await assert.rejects(publishIOSRelease({ tag, commit, exists: name => name === 'ios/App/shuguang.ipa', wait: async () => {}, warn() {}, run: args => {
    if (args[1] === 'upload') { uploads++; throw new Error('permission denied'); }
  } }), /permission denied/);
  assert.equal(uploads, 4);
});
