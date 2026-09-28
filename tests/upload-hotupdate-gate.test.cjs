const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const script = path.join(__dirname, '..', 'scripts', 'upload-hotupdate.cjs');
test('hot-update upload validates archive integrity before loading SSH dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-hotupdate-upload-'));
  const zip = path.join(root, 'bundle.zip');
  const manifest = path.join(root, 'manifest.json');
  const bytes = Buffer.from('fixture archive');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(zip, bytes);
  const valid = { version: '20260927123456', url: 'www.zip', size: bytes.length, sha256: digest, integrity: { algorithm: 'sha256', value: digest } };
  fs.writeFileSync(manifest, JSON.stringify(valid));
  try {
    const modulePath = require.resolve(script);
    delete require.cache[modulePath];
    const uploader = require(script);
    assert.equal(uploader.validateLocalRelease(zip, manifest).sha256, digest);
    for (const bad of [
      { ...valid, size: bytes.length + 1 },
      { ...valid, sha256: 'f'.repeat(64) },
      { ...valid, url: 'evil.zip' },
      { ...valid, version: 'latest' }
    ]) {
      fs.writeFileSync(manifest, JSON.stringify(bad));
      assert.throws(() => uploader.validateLocalRelease(zip, manifest), /hot-update manifest/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
