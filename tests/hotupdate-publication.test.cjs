const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const python = process.platform === 'win32' ? 'python' : 'python3';
const publisher = path.resolve('scripts/publish-hotupdate.py');

test('concurrent releases cannot replace an already published build, and old URLs stay immutable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-release-gate-'));
  const commitA = 'a'.repeat(40), commitB = 'b'.repeat(40), commitC = 'c'.repeat(40);
  function stage(name, version, commit, baseline, ancestors = [commit]) {
    const dir = path.join(root, '.incoming-' + name); fs.mkdirSync(dir);
    execFileSync(python, ['-c', 'import sys,zipfile,json\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n z.writestr("index.html",sys.argv[2]); z.writestr("release-info.json",json.dumps({"commit":sys.argv[2]}))', path.join(dir, 'www.zip'), commit]);
    const bytes = fs.readFileSync(path.join(dir, 'www.zip')), digest = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version, commit, ancestors, baseManifestSha256: baseline, url: 'www.zip', sha256: digest, size: bytes.length, integrity: { algorithm: 'sha256', value: digest } }));
    return dir;
  }
  const run = dir => execFileSync(python, [publisher, root, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const baseline = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'manifest.json'))).digest('hex');
  try {
    const first = JSON.parse(run(stage('first', '20261004000000', commitA, null)));
    const firstBytes = fs.readFileSync(path.join(root, first.url));
    const base = baseline();
    const b = stage('b', '20261004000001', commitB, base, [commitB, commitA]);
    const c = stage('c', '20261004000002', commitC, base, [commitC, commitB, commitA]);
    const launch = dir => new Promise(resolve => { const child = spawn(python, [publisher, root, dir]); let err = ''; child.stderr.on('data', d => { err += d; }); child.on('close', code => resolve({ code, err })); });
    const results = await Promise.all([launch(b), launch(c)]);
    assert.equal(results.filter(r => r.code === 0).length, 1);
    assert.match(results.find(r => r.code !== 0).err, /Another release/);
    assert.deepEqual(fs.readFileSync(path.join(root, first.url)), firstBytes);
    assert.throws(() => run(stage('old', '20261003000000', 'd'.repeat(40), baseline(), ['d'.repeat(40), commitA, commitB, commitC])), /older/);
    assert.throws(() => run(stage('unrelated', '20261005000000', 'e'.repeat(40), baseline())), /previously published/);
    const before = fs.readFileSync(path.join(root, 'manifest.json'));
    const corrupt = stage('corrupt', '20261005000001', 'f'.repeat(40), baseline());
    fs.appendFileSync(path.join(corrupt, 'www.zip'), 'corrupted');
    assert.throws(() => run(corrupt), /integrity/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'manifest.json')), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('server and client reject older timestamp versions including fallback manifests', () => {
  const server = require('../backend/update-version');
  const ts = require('typescript');
  const vm = require('node:vm');
  const output = ts.transpileModule(fs.readFileSync('src/services/update-version.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {} }; vm.runInNewContext(output, context);
  for (const implementation of [server, context.exports]) {
    assert.equal(implementation.isNewerVersion('20261004000002', '20261004000001'), true);
    assert.equal(implementation.isNewerVersion('20261004000001', '20261004000002'), false);
    assert.equal(implementation.isNewerVersion('20261004000001', '20261004000001'), false);
    assert.equal(implementation.isNewerVersion('20261004000001', 'builtin'), true);
    assert.equal(implementation.isNewerVersion('unknown', '20261004000001'), false);
  }
});
