const test = require('node:test');
const assert = require('node:assert/strict');
const { cancelSuperseded, uniqueStage, verifyPrepared } = require('../scripts/upload-ios.cjs');

const sha = 'a'.repeat(40);
const nonce = '12345678-1234-1234-1234-123456789abc';

test('iOS staging is unique and tied to the workflow attempt', () => {
  const stage = uniqueStage({ GITHUB_RUN_ID: '4046', GITHUB_RUN_ATTEMPT: '2' }, nonce);
  assert.equal(stage, '/tmp/warehouse-ios-4046-2-' + nonce);
  assert.throws(() => uniqueStage({ GITHUB_RUN_ID: '../4046' }, nonce), /staging identity/);
});

test('published metadata must match the exact workflow build, source and versioned IPA', () => {
  const env = { GITHUB_RUN_NUMBER: '280', GITHUB_SHA: sha };
  const metadata = {
    build: '280', sourceCommit: sha, url: '/download/shuguang-1.1.147-280-abcdef123456.ipa',
    sha256: 'b'.repeat(64), sizeBytes: 123,
  };
  assert.doesNotThrow(() => verifyPrepared(metadata, env));
  assert.throws(() => verifyPrepared({ ...metadata, build: '279' }, env), /build/);
  assert.throws(() => verifyPrepared({ ...metadata, sourceCommit: 'c'.repeat(40) }, env), /source commit/);
  assert.throws(() => verifyPrepared({ ...metadata, url: '/shuguang.ipa' }, env), /versioned/);
});

test('only older in-progress iOS runs on the same branch are cancelled', async () => {
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' });
    if (options.method === 'POST') return { ok: true, status: 202 };
    return {
      ok: true,
      async json() { return { workflow_runs: [
        { id: 1, run_number: 278, status: 'in_progress' },
        { id: 2, run_number: 279, status: 'completed' },
        { id: 3, run_number: 280, status: 'in_progress' },
        { id: 4, run_number: 281, status: 'queued' },
      ] }; },
    };
  };
  const cancelled = await cancelSuperseded('281', '281', {
    GITHUB_ACTIONS: 'true', GH_TOKEN: 'token', GITHUB_REPOSITORY: 'owner/repo', GITHUB_REF_NAME: 'main',
  }, fetch);
  assert.deepEqual(cancelled, [1, 3]);
  assert.deepEqual(requests.map(request => request.method), ['GET', 'POST', 'POST']);
  assert.match(requests[0].url, /branch=main/);
});
