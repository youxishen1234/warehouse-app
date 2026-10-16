const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../ios/App/App/Vendor/NIIMBOT');
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'provenance.json'), 'utf8'));
assert.equal(provenance.platform, 'iOS device arm64 only');
assert.ok(/^[a-f0-9]{64}$/.test(provenance.packageSha256), 'source archive SHA256');
assert.deepEqual(Object.keys(provenance.files).sort(), ['JCAPI.a', 'JCAPI.h', 'libSkiaRenderLibrary.a'].sort(), 'matched vendor set');
assert.ok(fs.readFileSync(path.join(root, 'JCAPI.h'), 'utf8').startsWith('//version ' + provenance.headerVersionComment), 'paired header version comment');
for (const [name, expected] of Object.entries(provenance.files)) {
  const bytes = fs.readFileSync(path.join(root, name));
  assert.equal(bytes.length, expected.size, name + ' size');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected.sha256, name + ' original SHA256');
  if (!name.endsWith('.a')) continue;
  assert.equal(bytes.subarray(0, 8).toString(), '!<arch>\n');
  let objects = 0;
  for (let pos = 8; pos + 60 <= bytes.length;) {
    const header = bytes.subarray(pos, pos + 60);
    const size = Number(header.subarray(48, 58).toString().trim());
    assert.ok(Number.isSafeInteger(size) && size > 0 && pos + 60 + size <= bytes.length);
    const entryName = header.subarray(0, 16).toString().trim();
    const start = pos + 60 + (entryName.startsWith('#1/') ? Number(entryName.slice(3)) : 0);
    const object = bytes.subarray(start, pos + 60 + size);
    pos += 60 + size + size % 2;
    if (object.length < 32 || object.readUInt32LE(0) !== 0xfeedfacf) continue;
    assert.equal(object.readUInt32LE(4), 0x100000c, name + ' arm64');
    let platform = false;
    let command = 32;
    for (let i = 0; i < object.readUInt32LE(16); i++) {
      const type = object.readUInt32LE(command), length = object.readUInt32LE(command + 4);
      assert.ok(length >= 8 && command + length <= object.length);
      if (type === 0x25) platform = true; // LC_VERSION_MIN_IPHONEOS on arm64
      if (type === 0x32) { assert.equal(object.readUInt32LE(command + 8), 2); platform = true; }
      command += length;
    }
    assert.ok(platform, name + ' iOS device target');
    objects++;
  }
  assert.ok(objects > 0);
  console.log(name + ': original bytes verified; ' + objects + ' arm64 iOS objects');
}
console.log('NIIMBOT vendor artifacts verified. Run verify-label-print-ios.cjs for the new integration; Xcode linking and physical printing are separate checks.');
