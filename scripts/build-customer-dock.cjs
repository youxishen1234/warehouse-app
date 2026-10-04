const path = require('node:path');
const webpack = require('webpack');
webpack({
  mode: 'production',
  entry: path.resolve(__dirname, '../prototypes/customer-dock.ts'),
  output: { path: path.resolve(process.env.WAREHOUSE_BUILD_STAGE || 'release', 'customer-desk'), filename: 'customer-dock.js' },
  resolve: { extensions: ['.ts', '.js'] },
  module: { rules: [{ test: /\.ts$/, use: path.resolve(__dirname, 'typescript-transpile-loader.cjs') }] },
}, (error, stats) => {
  if (error || stats.hasErrors()) {
    console.error(error || stats.toString({ all: false, errors: true }));
    process.exitCode = 1;
    return;
  }
  console.log('Built customer page with the shared app dock.');
});
