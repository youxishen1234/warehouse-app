const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('API helpers encode optional order filters and sorting without changing default routes', async () => {
  const requests = [];
  const source = fs.readFileSync(path.resolve('src/services/api.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const api = {};
  vm.runInNewContext(compiled, { exports: api, require: id => {
    assert.equal(id, './request', 'the server sort schema must be a type-only dependency');
    return { request: options => { requests.push(options); return Promise.resolve([]); } };
  } });
  await api.getOrders();
  await api.getOrders({});
  assert.deepEqual(requests.map(request => request.url), ['/api/orders', '/api/orders']);
  await api.getOrders({ status: '生产中', sort: 'amount', order: 'desc' });
  const filtered = new URL(requests.at(-1).url, 'http://test.invalid');
  assert.equal(filtered.searchParams.get('status'), '生产中');
  assert.equal(filtered.searchParams.get('sort'), 'amount');
  assert.equal(filtered.searchParams.get('order'), 'desc');
  for (const method of ['getProductsPage', 'getCustomersPage', 'getSuppliersPage', 'getTransactionsPage', 'getLedgerPage', 'getStocktakesPage', 'getDeliveryNotesPage', 'getOrdersPage']) {
    await api[method]({ page: 2, page_size: 10, sort: 'id', order: 'asc' });
    const query = new URL(requests.at(-1).url, 'http://test.invalid').searchParams;
    assert.deepEqual(Object.fromEntries(query), { page: '2', page_size: '10', sort: 'id', order: 'asc' }, method);
  }
  await api.getOrderEventsPage(7, { page: 1, page_size: 2, sort: 'created_at', order: 'asc' });
  assert.equal(requests.at(-1).url, '/api/orders/7/events?page=1&page_size=2&sort=created_at&order=asc');
  await api.getOrdersPage({ page: 1, page_size: 1, status: '已完成' });
  assert.equal(new URL(requests.at(-1).url, 'http://test.invalid').searchParams.get('status'), '已完成');
  await api.getLedgerPage({ page: 2, page_size: 5, type: 'income', keyword: 'review', include_voided: true, sort: 'amount', order: 'asc' });
  const ledgerQuery = new URL(requests.at(-1).url, 'http://test.invalid').searchParams;
  assert.equal(ledgerQuery.get('include_voided'), 'true');
  assert.equal(ledgerQuery.get('type'), 'income');
  assert.equal(ledgerQuery.get('keyword'), 'review');

});

test('client sort field types use the exact resource allowlist', () => {
  const options = { strict: true, noEmit: true, skipLibCheck: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, allowJs: true, baseUrl: path.resolve('.'), paths: { '@/*': ['src/*'] }, allowSyntheticDefaultImports: true };
  const filename = path.resolve('tests/__api-query-typecheck__.ts');
  const source = `import { getProductsPage, getCustomersPage, getOrders, getLedgerPage } from '../src/services/api';
getProductsPage({ page: 1, page_size: 20, sort: 'profile_updated_at', order: 'asc' });
getCustomersPage({ page: 1, page_size: 20, sort: 'balance_updated_at' });
getOrders({ status: '待生产', sort: 'amount' });
// @ts-expect-error Images are not sortable even though Product has image_url.
getProductsPage({ page: 1, page_size: 20, sort: 'image_url' });
// @ts-expect-error Customer fields cannot be used to sort ledger data.
getLedgerPage({ page: 1, page_size: 20, sort: 'debt' });
// @ts-expect-error Unknown states must not be exposed by typed helpers.
getOrders({ status: 'unknown' });
// @ts-expect-error Directions are lowercase asc or desc only.
getOrders({ order: 'ascending' });`;
  const host = ts.createCompilerHost(options);
  const getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...args) => path.resolve(file) === filename ? ts.createSourceFile(file, source, options.target, true) : getSource(file, ...args);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.file && path.resolve(diagnostic.file.fileName) === filename);
  assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});
