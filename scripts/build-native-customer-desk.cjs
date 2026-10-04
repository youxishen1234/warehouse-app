const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
execFileSync(process.execPath, [path.join(__dirname, 'build-customer-desk.cjs')], { cwd: root, stdio: 'inherit' });
const output = path.resolve(root, process.env.TARO_OUTPUT_DIR || 'dist');
fs.mkdirSync(output, { recursive: true });
for (const [folder, names] of [
  ['customer-desk', ['customer-desk.html', 'customer-desk.js', 'customer-dock.js']],
  ['qr-test', ['spec-test.html', 'spec-label.js']],
]) {
  for (const name of names) fs.copyFileSync(path.resolve(root, process.env.WAREHOUSE_BUILD_STAGE || 'release', folder, name), path.join(output, name));
}
console.log('Packaged customer dimensions and labels with the app.');
