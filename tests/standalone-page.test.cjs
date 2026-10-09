const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('src/services/standalone-page.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

test('standalone pages resolve from web, history, subdirectory and native app roots', () => {
  for (const [base, native, expected] of [
    ['https://warehouse.test/#/pages/customer-desk/index', false, 'https://warehouse.test/customer-desk.html'],
    ['https://warehouse.test/pages/customer-desk/index', false, 'https://warehouse.test/customer-desk.html'],
    ['https://warehouse.test/workspace/pages/customer-desk/index', false, 'https://warehouse.test/workspace/customer-desk.html'],
    ['https://warehouse.test/workspace/index.html#/pages/customer-desk/index', false, 'https://warehouse.test/workspace/customer-desk.html'],
    ['file:///C:/app/www/index.html#/pages/customer-desk/index', false, 'file:///C:/app/www/customer-desk.html?client=app'],
    ['capacitor://localhost/index.html#/pages/customer-desk/index', true, 'capacitor://localhost/customer-desk.html?client=app']
  ]) {
    const context = { exports: {}, URL, document: { baseURI: base }, window: { location: new URL(base) }, Capacitor: { isNativePlatform: () => native } };
    vm.runInNewContext(code, context);
    assert.equal(context.exports.standalonePageUrl('customer-desk.html').href, expected);
  }
});
