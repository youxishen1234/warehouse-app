const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
// Windows 用 powershell.exe；Linux/macOS 上 pwsh 存在时用 pwsh，否则跳过该平台相关用例。
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
function hasPowerShell() {
  try { execFileSync(POWERSHELL, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 20000 }); return true; }
  catch { return false; }
}

test('native asset sync removes stale assets and copies source-root files', { skip: process.platform !== 'win32' && !hasPowerShell() }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-native-sync-'));
  const source = path.join(root, 'dist');
  const target = path.join(root, 'www');
  fs.mkdirSync(path.join(source, 'js'), { recursive: true });
  fs.mkdirSync(path.join(source, 'css'), { recursive: true });
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(target, 'js'), { recursive: true });
  fs.mkdirSync(path.join(target, 'css'), { recursive: true });
  fs.writeFileSync(path.join(source, 'index.html'), '<div>new app</div>');
  fs.writeFileSync(path.join(target, 'js', 'old-ui.js'), 'obsolete');
  fs.writeFileSync(path.join(source, 'js', 'app.js'), 'built-app');
  fs.writeFileSync(path.join(source, 'css', 'web-shell.css'), 'current-shell');
  fs.writeFileSync(path.join(source, 'nested', 'chunk.js'), 'built-chunk');
  fs.writeFileSync(path.join(target, 'js', 'home-search.js'), 'source-search');
  fs.writeFileSync(path.join(target, 'css', 'polish.css'), 'source-polish');
  const script = path.join(__dirname, '..', 'scripts', 'sync-native-assets.ps1');
  execFileSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Source', source, '-Target', target], { stdio: 'pipe' });
  assert.equal(fs.readFileSync(path.join(target, 'js', 'app.js'), 'utf8'), 'built-app');
  assert.equal(fs.readFileSync(path.join(target, 'nested', 'chunk.js'), 'utf8'), 'built-chunk');
  assert.equal(fs.existsSync(path.join(target, 'js', 'home-search.js')), false);
  assert.equal(fs.existsSync(path.join(target, 'css', 'polish.css')), false);
  assert.equal(fs.readFileSync(path.join(target, 'css', 'web-shell.css'), 'utf8'), 'current-shell');
  assert.equal(fs.existsSync(path.join(target, 'js', 'old-ui.js')), false);
});

test('invalid and overlapping build directories cannot erase packaged assets', { skip: process.platform !== 'win32' && !hasPowerShell() }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-sync-safety-'));
  const source = path.join(root, 'build');
  const target = path.join(root, 'www');
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'index.html'), 'previous-valid-build');
  const script = path.join(__dirname, '..', 'scripts', 'sync-native-assets.ps1');
  const invoke = (from, to) => execFileSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Source', from, '-Target', to], { stdio: 'pipe' });
  assert.throws(() => invoke(source, target));
  assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), 'previous-valid-build');
  assert.throws(() => invoke(target, target));
  assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), 'previous-valid-build');
});
