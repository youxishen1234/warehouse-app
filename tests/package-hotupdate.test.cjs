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
      env: { ...process.env, HOTUPDATE_COMMIT: '', HOTUPDATE_VERSION: '2026.09.27-test', HOTUPDATE_DISPLAY_VERSION: '1.23', HOTUPDATE_RELEASE_NOTES: 'integrity test' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const archive = fs.readFileSync(output);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const digest = crypto.createHash('sha256').update(archive).digest('hex');
    assert.equal(manifest.version, '2026.09.27-test');
    assert.equal(manifest.displayVersion, '1.23');
    assert.equal(manifest.url, 'www.zip');
    assert.equal(manifest.size, archive.length);
    assert.equal(manifest.sha256, digest);
    assert.deepEqual(manifest.integrity, { algorithm: 'sha256', value: digest });
    assert.equal(manifest.releaseNotes, 'integrity test');
    const names = execFileSync(python, ['-c', 'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', output], { encoding: 'utf8' });
    assert.match(names, /(?:^|\r?\n)index\.html(?:\r?\n|$)/);

    for (const invalidVersion of ['latest', '2026.09', '../2026.09.27', '2026-09-27']) {
      assert.throws(() => execFileSync(python, [script, source, output, manifestPath], {
        env: { ...process.env, HOTUPDATE_COMMIT: '', HOTUPDATE_VERSION: invalidVersion, HOTUPDATE_DISPLAY_VERSION: '1.23' },
        stdio: ['ignore', 'pipe', 'pipe']
      }), new RegExp('HOTUPDATE_VERSION'));
    }
    for (const invalidDisplayVersion of ['1', '1.23.4', 'v1.24']) {
      assert.throws(() => execFileSync(python, [script, source, output, manifestPath], {
        env: { ...process.env, HOTUPDATE_COMMIT: '', HOTUPDATE_VERSION: '2026.09.27-test', HOTUPDATE_DISPLAY_VERSION: invalidDisplayVersion },
        stdio: ['ignore', 'pipe', 'pipe']
      }), new RegExp('HOTUPDATE_DISPLAY_VERSION'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package-hotupdate rejects a repeated display version only when provenance is released', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-hotupdate-display-gate-'));
  const source = path.join(root, 'dist');
  const output = path.join(root, 'release', 'www.zip');
  const manifestPath = path.join(root, 'release', 'manifest.json');
  const baseline = path.join(root, 'base-manifest.json');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'index.html'), '<!doctype html>\n');
  fs.writeFileSync(path.join(source, 'release-info.json'), JSON.stringify({ commit, displayVersion: '1.23' }));
  fs.writeFileSync(baseline, JSON.stringify({ displayVersion: '1.23' }));
  try {
    assert.throws(() => execFileSync(python, [script, source, output, manifestPath], {
      env: {
        ...process.env,
        HOTUPDATE_COMMIT: commit,
        HOTUPDATE_VERSION: '20261030190000',
        HOTUPDATE_DISPLAY_VERSION: '1.23',
        HOTUPDATE_BASE_MANIFEST: baseline
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }), /must advance/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
