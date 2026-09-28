const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

test('native asset sync preserves source-owned auxiliary assets and copies source-root files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-native-sync-'));
  const source = path.join(root, 'dist');
  const target = path.join(root, 'www');
  fs.mkdirSync(path.join(source, 'js'), { recursive: true });
  fs.mkdirSync(path.join(source, 'css'), { recursive: true });
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(target, 'js'), { recursive: true });
  fs.mkdirSync(path.join(target, 'css'), { recursive: true });
  fs.writeFileSync(path.join(source, 'js', 'app.js'), 'built-app');
  fs.writeFileSync(path.join(source, 'js', 'home-search.js'), 'built-search');
  fs.writeFileSync(path.join(source, 'css', 'polish.css'), 'built-polish');
  fs.writeFileSync(path.join(source, 'nested', 'chunk.js'), 'built-chunk');
  fs.writeFileSync(path.join(target, 'js', 'home-search.js'), 'source-search');
  fs.writeFileSync(path.join(target, 'css', 'polish.css'), 'source-polish');
  const script = path.join(__dirname, '..', 'scripts', 'sync-native-assets.ps1');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Source', source, '-Target', target], { stdio: 'pipe' });
  assert.equal(fs.readFileSync(path.join(target, 'js', 'app.js'), 'utf8'), 'built-app');
  assert.equal(fs.readFileSync(path.join(target, 'nested', 'chunk.js'), 'utf8'), 'built-chunk');
  assert.equal(fs.readFileSync(path.join(target, 'js', 'home-search.js'), 'utf8'), 'source-search');
  assert.equal(fs.readFileSync(path.join(target, 'css', 'polish.css'), 'utf8'), 'source-polish');
});
