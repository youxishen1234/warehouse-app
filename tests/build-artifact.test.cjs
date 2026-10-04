const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function files(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...files(full));
    else result.push(full);
  }
  return result;
}

for (const output of [process.env.TARO_OUTPUT_DIR || 'dist', 'www']) {
  test(`${output} release assets do not publish source maps`, () => {
    const root = path.resolve(output);
    assert.ok(fs.existsSync(root), `${output} must exist after a build`);
    const assets = files(root);
    assert.equal(assets.filter(file => file.endsWith('.map')).length, 0, `${output} must not contain .map files`);
    for (const file of assets.filter(item => /\.(?:js|css|html)$/.test(item))) {
      const text = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /(?:^|\r?\n)\s*(?:\/\/|\/\*)[#@]\s*sourceMappingURL=/, `${output}/${path.relative(root, file)} must not point to a source map`);
    }
  });
}

test('release verification uses a fail-fast PowerShell script', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(packageJson.scripts['verify:release'], /verify-release\.ps1/);
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-release.ps1'), 'utf8');
  assert.match(script, /ErrorActionPreference\s*=\s*['"]Stop['"]/i);
  assert.match(script, /LASTEXITCODE/);
  assert.match(script, /npm run build:h5/);
  assert.match(script, /npm run verify:fast/);
});
