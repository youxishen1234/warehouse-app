const fs = require('node:fs');
const path = require('node:path');
const webpack = require('webpack');

const root = path.resolve(__dirname, '..');
const stage = path.resolve(root, process.env.WAREHOUSE_BUILD_STAGE || 'release');
const labelDir = path.join(stage, 'qr-test');
fs.mkdirSync(labelDir, { recursive: true });

function run(config) {
  return new Promise((resolve, reject) => {
    webpack(config, (error, stats) => {
      if (error) return reject(error);
      if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
      resolve();
    });
  });
}

async function buildLabels() {
  await run({
    mode: 'production',
    entry: path.join(root, 'prototypes/spec-label.js'),
    output: { path: labelDir, filename: 'spec-label.js' },
  });
  fs.copyFileSync(path.join(root, 'prototypes/spec-test.html'), path.join(labelDir, 'spec-test.html'));
  console.log('Built QR label printer assets.');
}

module.exports = buildLabels;
if (require.main === module) {
  buildLabels().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
