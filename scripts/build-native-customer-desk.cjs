const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
async function main() {
  await require('./build-customer-desk.cjs')();
  const output = path.resolve(root, process.env.TARO_OUTPUT_DIR || 'dist');
  fs.mkdirSync(output, { recursive: true });
  for (const [folder, names] of [
    ['customer-desk', ['customer-desk.html', 'customer-desk.js', 'customer-dock.js']],
    ['qr-test', ['spec-test.html', 'spec-label.js']],
  ]) {
    for (const name of names) fs.copyFileSync(path.resolve(root, process.env.WAREHOUSE_BUILD_STAGE || 'release', folder, name), path.join(output, name));
  }
  console.log('Packaged customer dimensions and labels with the app.');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
