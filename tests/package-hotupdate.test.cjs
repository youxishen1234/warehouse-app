const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.join(__dirname, '..', 'scripts', 'package-hotupdate.py');

test('package-hotupdate emits a SHA256 manifest for the exact archive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-hotupdate-package-'));
  const source = path.join(root, 'dist');
  const output = path.join(root, 'release', 'www.zip');
  const manifestPath = path.join(root, 'release', 'manifest.json');
  fs.mkdirSync(path.join(source, 'js'), { recursive: true });
  fs.writeFileSync(path.join(source, 'index.html'), '<!doctype html><script src="./js/app.js"></script>\n');
  fs.writeFileSync(path.join(source, 'js', 'app.js'), 'console.log("hot-update");\n');
  try {
    execFileSync(python, [script, source, output, manifestPath], {
      env: { ...process.env, HOTUPDATE_COMMIT: '', HOTUPDATE_VERSION: '2026.09.27-test', HOTUPDATE_RELEASE_NOTES: 'integrity test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const archive = fs.readFileSync(output);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const digest = crypto.createHash('sha256').update(archive).digest('hex');
    assert.equal(manifest.version, '2026.09.27-test');
    assert.equal(manifest.url, 'www.zip');
    assert.equal(manifest.size, archive.length);
    assert.equal(manifest.sha256, digest);
    assert.deepEqual(manifest.integrity, { algorithm: 'sha256', value: digest });
    assert.equal(manifest.releaseNotes, 'integrity test');
    const names = execFileSync(python, ['-c', 'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', output], { encoding: 'utf8' });
    assert.match(names, /(?:^|\r?\n)index\.html(?:\r?\n|$)/);

    for (const invalidVersion of ['latest', '2026.09', '../2026.09.27', '2026-09-27']) {
      assert.throws(() => execFileSync(python, [script, source, output, manifestPath], {
        env: { ...process.env, HOTUPDATE_COMMIT: '', HOTUPDATE_VERSION: invalidVersion },
        stdio: ['ignore', 'pipe', 'pipe']
      }), new RegExp('HOTUPDATE_VERSION'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
