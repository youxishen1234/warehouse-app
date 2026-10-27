const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const model = {};
const source = fs.readFileSync('src/components/CustomerCenter/model.ts', 'utf8');
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText, { exports: model });

const quote = overrides => ({
  id: 'quote-a', goods: '报价纸箱', specification: '40×30×20 cm',
  material: '五层', unit: '个', price: 0.123456789, kind: '成品', ...overrides
});

const customer = (id, overrides = {}) => ({
  id, name: `客户${id}`, contact: '', phone: '', address: '', remark: '', debt: 0,
  created_at: 1, updated_at: 1, specs: [], ...overrides
});

const dimension = (id, name, specs) => ({ id, name, specs });

test('formats valid prices without reducing stored precision', () => {
  assert.equal(model.formatCustomerUnitPrice(0), '¥0.00');
  assert.equal(model.formatCustomerUnitPrice(1.2), '¥1.20');
  assert.equal(model.formatCustomerUnitPrice(0.123456789), '¥0.123456789');
  assert.equal(model.formatCustomerUnitPrice(1e-7), '¥0.0000001');
  assert.equal(model.formatCustomerUnitPrice(null), '价格未记录');
  assert.equal(model.formatCustomerUnitPrice(-1), '¥-1.00');
});

test('keeps other quotes when appending a new quote and detects same-id conflicts', () => {
  const other = quote({ id: 'other', price: 2 });
  const added = quote({ id: 'new' });
  const result = model.appendCustomerSpecQuote([other], added);
  assert.deepEqual(JSON.parse(JSON.stringify(result.specs)), [other, added]);
  assert.equal(result.alreadySaved, false);
  assert.throws(() => model.appendCustomerSpecQuote(result.specs, { ...added, price: 9 }), /草稿已保留/);
  assert.equal(result.specs.length, 2, 'conflict must not mutate the source list');
});

test('keeps identical quotes with different IDs independently editable', () => {
  const account = customer(5, { specs: [quote({ id: 'first' }), quote({ id: 'second' })] });
  const specs = model.buildCustomerManagementRows([account], [])[0].specs;
  assert.deepEqual(Array.from(specs, spec => spec.quoteId), ['first', 'second']);
});

test('matches dimension sources by exact tuple instead of joined strings', () => {
  const account = customer(7, {
    name: '客户改名后',
    specs: [quote({ dimension_source: { customer_id: 'a:b', spec_id: 'c' } })]
  });
  const dimensions = [
    dimension('a:b', '客户改名后', [{ id: 'c', goods: '已转报价', size: '40×30×20', sizeUnit: 'cm', material: '五层', unit: '个', kind: '成品' }]),
    dimension('a', '客户改名后', [{ id: 'b:c', goods: '冒号碰撞', size: '50×40×30', sizeUnit: 'cm', material: '五层', unit: '个', kind: '成品' }])
  ];
  const rows = model.buildCustomerManagementRows([account], dimensions);
  const specs = rows.find(row => row.account)?.specs || [];
  assert.equal(specs.some(spec => spec.goods === '已转报价'), false, 'linked source must be hidden');
  assert.equal(specs.some(spec => spec.key === 'dimension:a:b:c'), true, 'different tuple must remain visible');
  assert.equal(specs.filter(spec => spec.goods === '冒号碰撞').length, 1);
});

test('hides a dimension source after the customer is renamed', () => {
  const account = customer(9, {
    name: '新客户名',
    specs: [quote({ dimension_source: { customer_id: 'dimension-old', spec_id: 'old-spec' } })]
  });
  const dimensions = [dimension('dimension-old', '旧客户名', [{
    id: 'old-spec', goods: '旧尺寸', size: '60×40×30', sizeUnit: 'cm',
    material: '', unit: '个', kind: '成品'
  }])];
  const rows = model.buildCustomerManagementRows([account], dimensions);
  assert.equal(rows.filter(row => row.account).length, 1);
  assert.equal(rows.find(row => row.account)?.specs.length, 1);
  assert.equal(rows.some(row => !row.account), false, 'an entirely linked stale dimension customer must not leave an empty card');
});

test('keeps paperboard quotes separate from carton matches and rejects invalid prices', () => {
  const account = customer(11, {
    specs: [
      quote({ id: 'board', goods: '纸板', specification: '120×80 cm', kind: '纸板', price: 3 }),
      quote({ id: 'invalid-price', price: -1 })
    ]
  });
  const specs = model.buildCustomerManagementRows([account], [])[0].specs;
  assert.equal(specs.find(spec => spec.quoteId === 'board').kind, '纸板');
  assert.equal(specs.find(spec => spec.quoteId === 'invalid-price').price, null);
});
