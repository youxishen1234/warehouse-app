const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
async function main() {
  await require('./build-labels.cjs')();
  const output = path.resolve(root, process.env.TARO_OUTPUT_DIR || 'dist');
  fs.mkdirSync(output, { recursive: true });
  for (const name of ['spec-test.html', 'spec-label.js']) {
    fs.copyFileSync(path.resolve(root, process.env.WAREHOUSE_BUILD_STAGE || 'release', 'qr-test', name), path.join(output, name));
  }
  console.log('Packaged label printer assets with the app.');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
