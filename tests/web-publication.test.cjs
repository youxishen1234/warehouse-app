const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const publisher = path.resolve('scripts/publish-hotupdate.py');

test('web and hot update share a commit; rejected and failed releases retain the live website', { skip: process.platform === 'win32' ? 'Production uses POSIX symlinks; run this test on Linux' : false }, () => {
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-web-publish-'));
  const root = path.join(web, 'appupdate');
  fs.mkdirSync(root);
  function stage(name, commit, base, ancestors, files) {
    const incoming = path.join(root, '.incoming-' + name); fs.mkdirSync(incoming);
    const entries = { 'index.html': commit, 'release-info.json': JSON.stringify({ commit }), ...files };
    execFileSync(python, ['-c', `import sys,json,zipfile
with zipfile.ZipFile(sys.argv[1],"w") as z:
 for name,body in json.loads(sys.argv[2]).items(): z.writestr(name,body)`, path.join(incoming, 'www.zip'), JSON.stringify(entries)]);
    const bytes = fs.readFileSync(path.join(incoming, 'www.zip'));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(incoming, 'manifest.json'), JSON.stringify({ version: '2026100900000' + name, commit, ancestors, baseManifestSha256: base, size: bytes.length, sha256, integrity: { algorithm: 'sha256', value: sha256 } }));
    return incoming;
  }
  const run = incoming => execFileSync(python, [publisher, root, incoming, web], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const baseline = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'manifest.json'))).digest('hex');
  const live = () => fs.readFileSync(path.join(web, 'web-current', 'index.html'), 'utf8');
  try {
    fs.writeFileSync(path.join(web, 'shuguang.apk'), 'installer');
    const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
    const first = JSON.parse(run(stage('1', a, null, [a], { 'js/app.aaaaaaaa.js': 'first' })));
    assert.equal(live(), a);
    assert.equal(JSON.parse(fs.readFileSync(path.join(web, 'web-current/release-info.json'))).commit, first.commit);
    const oldBase = baseline();
    run(stage('2', b, oldBase, [b, a], { 'js/app.bbbbbbbb.js': 'second' }));
    assert.equal(live(), b);
    assert.equal(fs.readFileSync(path.join(web, 'js/app.aaaaaaaa.js'), 'utf8'), 'first');
    assert.equal(fs.readFileSync(path.join(web, 'shuguang.apk'), 'utf8'), 'installer');
    assert.throws(() => run(stage('3', c, oldBase, [c, b, a])), /Another release/);
    assert.equal(live(), b);
    assert.throws(() => run(stage('4', c, baseline(), [c, b, a], { '../escape': 'bad' })), /Unsafe release/);
    assert.throws(() => run(stage('5', c, baseline(), [c, b, a], { 'js/app.aaaaaaaa.js': 'collision' })), /collision/);
    const before = fs.readFileSync(path.join(root, 'manifest.json'));
    const failed = stage('6', c, baseline(), [c, b, a], { 'js/app.cccccccc.js': 'third' });
    const fault = `import runpy,sys,os
m=runpy.run_path(sys.argv[1]); original=os.replace
def replace(src,dst):
 if str(dst).endswith("manifest.json"): raise OSError("simulated manifest failure")
 return original(src,dst)
os.replace=replace
m["publish"](*sys.argv[2:])`;
    assert.throws(() => execFileSync(python, ['-c', fault, publisher, root, failed, web], { stdio: ['ignore', 'pipe', 'pipe'] }), /simulated manifest failure/);
    assert.equal(live(), b);
    assert.deepEqual(fs.readFileSync(path.join(root, 'manifest.json')), before);
  } finally { fs.rmSync(web, { recursive: true, force: true }); }
});
