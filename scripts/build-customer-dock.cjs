const path = require('node:path');
const webpack = require('webpack');
function buildDock() {
  return new Promise((resolve, reject) => webpack({
    mode: 'production',
    entry: path.resolve(__dirname, '../prototypes/customer-dock.ts'),
    output: { path: path.resolve(process.env.WAREHOUSE_BUILD_STAGE || 'release', 'customer-desk'), filename: 'customer-dock.js' },
    resolve: { extensions: ['.ts', '.js'] },
    module: { rules: [{ test: /\.ts$/, use: path.resolve(__dirname, 'typescript-transpile-loader.cjs') }] },
  }, (error, stats) => {
    if (error || stats.hasErrors()) return reject(error || new Error(stats.toString({ all: false, errors: true })));
    console.log('Built customer page with the shared app dock.');
    resolve();
  }));
}

module.exports = buildDock;
if (require.main === module) buildDock().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
