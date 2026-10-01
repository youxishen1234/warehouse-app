const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('product store shares concurrent reads and supports invalidation', () => {
  const source = fs.readFileSync('src/services/product-store.ts', 'utf8');
  assert.match(source, /pending: Promise<Product\[\]> \| null/);
  assert.match(source, /if \(pending\) return pending/);
  assert.match(source, /export function invalidateProducts/);
  assert.match(fs.readFileSync('src/pages/home/index.tsx', 'utf8'), /loadProducts\(force\)/);
});

test('forced product refreshes coalesce and stale reads cannot refill an invalidated cache', async () => {
  const source = fs.readFileSync('src/services/product-store.ts', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const requests = [];
  const exports = {};
  const context = vm.createContext({ exports, Promise, Date, require: () => ({ getProducts: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) }) });
  vm.runInContext(compiled, context);

  const first = exports.loadProducts(true);
  const duplicate = exports.loadProducts(true);
  assert.equal(requests.length, 1, 'the return refresh shares the active page-load request');
  assert.equal(first, duplicate);
  requests[0].resolve([{ id: 1, name: 'before' }]);
  await first;

  const stale = exports.loadProducts(true);
  exports.invalidateProducts();
  const current = exports.loadProducts(true);
  assert.equal(requests.length, 3, 'inventory changes start a fresh generation');
  requests[2].resolve([{ id: 2, name: 'current' }]);
  await current;
  requests[1].resolve([{ id: 3, name: 'stale' }]);
  await stale;
  assert.deepEqual(await exports.loadProducts(), [{ id: 2, name: 'current' }]);
});
