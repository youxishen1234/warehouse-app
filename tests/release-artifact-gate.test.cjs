const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const yazl = require('yazl');

const script = path.join(__dirname, '..', 'scripts', 'verify-release-artifacts.cjs');

test('release verification wires the artifact gate and optional archive pin', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(packageJson.scripts['verify:release-artifacts'], /verify-release-artifacts\.cjs/);
  const verifyRelease = await fs.readFile(path.join(__dirname, '..', 'scripts', 'verify-release.ps1'), 'utf8');
  assert.match(verifyRelease, /verify-release-artifacts\.cjs/);
  assert.match(verifyRelease, /RELEASE_ZIP/);
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'warehouse-release-gate-'));
  const dist = path.join(root, 'dist');
  await fs.mkdir(path.join(dist, 'js'), { recursive: true });
  await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><script src="./js/app.js"></script>\n');
  await fs.writeFile(path.join(dist, 'js', 'app.js'), 'console.log("release");\n');
  return { root, dist };
}

function makeZip(directory, output, mutate) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const stream = require('node:fs').createWriteStream(output);
    stream.on('close', resolve);
    stream.on('error', reject);
    zip.outputStream.pipe(stream);
    const files = [
      ['index.html', '<!doctype html><script src="./js/app.js"></script>\n'],
      ['js/app.js', mutate ? 'console.log("old");\n' : 'console.log("release");\n'],
    ];
    for (const [name, contents] of files) zip.addBuffer(Buffer.from(contents), name, { mtime: new Date('1980-01-01T00:00:00Z') });
    zip.end();
  });
}

function run(args) {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('release gate accepts a clean directory and an exact archive', async () => {
  const { root, dist } = await fixture();
  const zip = path.join(root, 'release.zip');
  await makeZip(dist, zip, false);
  const output = run(['--dist', dist, '--zip', zip, '--json']);
  assert.deepEqual(JSON.parse(output), { dist, files: 2, zip });
});

test('release gate rejects stale archives, source maps, and credential-like values', async () => {
  const { root, dist } = await fixture();
  const zip = path.join(root, 'stale.zip');
  await makeZip(dist, zip, true);
  assert.throws(() => run(['--dist', dist, '--zip', zip]), /archive hash differs/);

  await fs.writeFile(path.join(dist, 'debug.js.map'), '{}');
  assert.throws(() => run(['--dist', dist]), /source map/);
  await fs.rm(path.join(dist, 'debug.js.map'));

  await fs.writeFile(path.join(dist, 'secret.txt'), 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890');
  assert.throws(() => run(['--dist', dist]), /credential-like/);
});
