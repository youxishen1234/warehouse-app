const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.resolve('src/pages/print-center/specification-library.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename);
const {
  MAX_PRINT_ITEMS,
  buildSpecificationOptions,
  filterSpecificationOptions,
  specificationAlreadyAdded,
  availableSpecificationSlots,
  addSpecificationOptions
} = loaded.exports;

const customerSpec = (overrides = {}) => ({
  id: 'box', goods: '纸箱', specification: '400 x 300 * 200 mm',
  material: '五层牛卡', unit: '个', price: 1.234567, ...overrides
});
const customer = (overrides = {}) => ({ id: 1, name: '甲客户', specs: [customerSpec()], ...overrides });
const product = (overrides = {}) => ({
  id: 11, name: '库存纸箱', specification: '500 x 400 x 300', material: '三层牛卡',
  unit: '个', price: 2.345678, ...overrides
});
const dimensionSpec = (overrides = {}) => ({
  id: 'dimension-box', goods: '尺寸本纸箱', size: '600 x 500 x 400', sizeUnit: 'mm',
  material: '七层牛卡', unit: '个', kind: '成品', ...overrides
});
const dimensionCustomer = (overrides = {}) => ({
  id: 'dimension-customer', name: '甲客户', specs: [dimensionSpec()], ...overrides
});
const option = (overrides = {}) => ({
  id: 'customer:1:box', source: 'customer', customer_id: 1, customer_name: '甲客户', product_id: null,
  name: '纸箱', specification: '400×300×200', material: '五层牛卡', price: '1.234567', unit: '个', ...overrides
});
let sequence = 0;
const blankItem = (overrides = {}) => ({
  key: `test-item-${++sequence}`, product_id: null, name: '', specification: '',
  quantity: '', price: '', remark: '', ...overrides
});
const itemFor = (entry, overrides = {}) => blankItem({
  product_id: entry.product_id, name: entry.name, specification: entry.specification,
  price: entry.price, remark: entry.material, ...overrides
});
const occupiedItems = count => Array.from({ length: count }, (_, index) => blankItem({
  name: `已填商品 ${index}`, specification: `${index + 1}×2×3`, quantity: '1'
}));

test('collects legacy customer specs, customer dimensions, and inventory products', () => {
  const options = buildSpecificationOptions([customer()], [product()], [dimensionCustomer()]);
  assert.equal(options.length, 3);
  const legacy = options.find(entry => entry.source === 'customer');
  assert.deepEqual(legacy, option());
  const dimension = options.find(entry => entry.source === 'dimension');
  assert.equal(dimension.customer_id, 1);
  assert.equal(dimension.customer_name, '甲客户');
  assert.equal(dimension.specification, '600×500×400');
  assert.equal(dimension.material, '七层牛卡');
  assert.equal(dimension.price, '');
  const inventory = options.find(entry => entry.source === 'product');
  assert.equal(inventory.product_id, 11);
  assert.equal(inventory.customer_id, null);
  assert.equal(inventory.specification, '500×400×300');
  assert.equal(inventory.price, '2.345678');
});

test('excludes deleted accounts and products, non-piece units, and empty specifications', () => {
  const options = buildSpecificationOptions([
    customer({ specs: [customerSpec(), customerSpec({ id: 'sheets', unit: '张' }), customerSpec({ id: 'empty', specification: '  ' })] }),
    customer({ id: 2, name: '已删除客户', deleted_at: 100 })
  ], [
    product(), product({ id: 12, deleted_at: 100 }), product({ id: 13, unit: '件' }),
    product({ id: 14, unit: '' }), product({ id: 15, specification: '' })
  ], [
    dimensionCustomer({ specs: [dimensionSpec(), dimensionSpec({ id: 'sheets', unit: '张' }), dimensionSpec({ id: 'empty', size: '' })] }),
    dimensionCustomer({ id: 'deleted', name: '已删除客户' })
  ]);
  assert.deepEqual(options.map(entry => entry.id).sort(), ['customer:1:box', 'dimension:dimension-customer:dimension-box', 'product:11']);
  assert.ok(options.every(entry => entry.unit === '个'));
});

test('keeps zero and full available price precision, and leaves missing prices blank', () => {
  const options = buildSpecificationOptions([customer({ specs: [
    customerSpec({ id: 'free', price: 0 }),
    customerSpec({ id: 'precise', price: 0.123456789 }),
    customerSpec({ id: 'unpriced', price: undefined })
  ] })], [
    product({ id: 11, price: 0 }), product({ id: 12, price: 0.987654321 }),
    product({ id: 13, price: undefined })
  ], [dimensionCustomer()]);
  const byId = new Map(options.map(entry => [entry.id, entry]));
  assert.equal(byId.get('customer:1:free').price, '0');
  assert.equal(byId.get('customer:1:precise').price, '0.123456789');
  assert.equal(byId.get('customer:1:unpriced').price, '');
  assert.equal(byId.get('product:11').price, '0');
  assert.equal(byId.get('product:12').price, '0.987654321');
  assert.equal(byId.get('product:13').price, '');
  assert.equal(byId.get('dimension:dimension-customer:dimension-box').price, '');
});

test('does not discard valid specifications with empty goods or product names', () => {
  const options = buildSpecificationOptions([customer({ specs: [customerSpec({ goods: '' })] })],
    [product({ name: '  ' })], [dimensionCustomer({ specs: [dimensionSpec({ goods: '' })] })]);
  assert.equal(options.length, 3);
  assert.ok(options.every(entry => entry.name === ''));
  const result = addSpecificationOptions([], options, blankItem);
  assert.equal(result.added, 3);
  assert.ok(result.items.every(item => item.name === '' && item.specification));
});

test('normalizes millimeters while preserving centimeter units and existing suffixes', () => {
  const options = buildSpecificationOptions([], [], [dimensionCustomer({ specs: [
    dimensionSpec({ id: 'mm', size: '40mm X 30ｍｍ 乘 20毫米', sizeUnit: 'mm' }),
    dimensionSpec({ id: 'cm', size: '40 * 30 * 20', sizeUnit: 'cm' }),
    dimensionSpec({ id: 'cm-suffix', size: '50 x 40 x 30 CM', sizeUnit: 'cm' })
  ] })]);
  assert.equal(options.find(entry => entry.id.endsWith(':mm')).specification, '40×30×20');
  assert.equal(options.find(entry => entry.id.endsWith(':cm')).specification, '40×30×20 cm');
  assert.equal(options.find(entry => entry.id.endsWith(':cm-suffix')).specification, '50×40×30 CM');
});

test('search accepts common dimension separators and millimeter notation', () => {
  const entry = option();
  for (const separator of ['x', 'X', '*', '＊', '✕', '乘', '×']) {
    assert.deepEqual(filterSpecificationOptions([entry], `400 ${separator} 300 ${separator} 200`), [entry]);
  }
  assert.deepEqual(filterSpecificationOptions([entry], '400mm x 300毫米 x 200ｍｍ'), [entry]);
  assert.deepEqual(filterSpecificationOptions([entry], '  '), [entry]);
});

test('search matches all whitespace-separated terms across size, goods, material, and customer', () => {
  const entry = option({ name: 'ABC 纸箱' });
  const others = [option({ id: 'other-material', material: '三层白卡' }), option({ id: 'other-customer', customer_name: '乙客户' })];
  assert.deepEqual(filterSpecificationOptions([entry, ...others], '甲客户 五层牛卡 400*300*200 abc'), [entry]);
  assert.deepEqual(filterSpecificationOptions([entry], `牛卡	纸箱
甲客户`), [entry]);
  assert.deepEqual(filterSpecificationOptions([entry], '五层牛卡 不存在'), []);
});

test('scopes by selected customer id or exact manually entered customer name', () => {
  const options = buildSpecificationOptions([customer(), customer({ id: 2, name: '乙客户' })], [product()], [
    dimensionCustomer(), dimensionCustomer({ id: 'manual', name: '手填客户' })
  ]);
  assert.deepEqual(filterSpecificationOptions(options, '', 1).map(entry => entry.source), ['customer', 'dimension']);
  assert.ok(filterSpecificationOptions(options, '', 1, '乙客户').every(entry => entry.customer_id === 1));
  assert.deepEqual(filterSpecificationOptions(options, '', undefined, '  甲客户  ').map(entry => entry.source), ['customer', 'dimension']);
  const manual = filterSpecificationOptions(options, '', undefined, '手填客户');
  assert.equal(manual.length, 1);
  assert.equal(manual[0].source, 'dimension');
  assert.equal(manual[0].customer_id, null);
  assert.deepEqual(filterSpecificationOptions(options, '', undefined, '甲'), []);
  assert.equal(filterSpecificationOptions(options, '').length, options.length);
});

test('retains distinct inventory ids even when products share a name and dimensions', () => {
  const options = buildSpecificationOptions([], [product({ id: 11 }), product({ id: 12 })]);
  assert.equal(options.length, 2);
  const result = addSpecificationOptions([], options, blankItem);
  assert.equal(result.added, 2);
  assert.deepEqual(result.items.map(item => item.product_id), [11, 12]);
  assert.equal(specificationAlreadyAdded([result.items[0]], options[1]), false);
  assert.equal(specificationAlreadyAdded(result.items, { ...options[0], name: '已改名', specification: '1×2×3' }), true);
});

test('recognizes already-added normalized specifications and skips duplicate selections', () => {
  const entry = option();
  const existing = itemFor(entry, { specification: '400mm x 300 * 200 mm', name: '  纸箱  ', remark: ' 五层牛卡 ' });
  assert.equal(specificationAlreadyAdded([existing], entry), true);
  assert.equal(specificationAlreadyAdded([existing], option({ material: '三层白卡' })), false);
  assert.equal(specificationAlreadyAdded([existing], option({ specification: '401×300×200' })), false);
  const unchanged = addSpecificationOptions([existing], [entry], blankItem);
  assert.equal(unchanged.added, 0);
  assert.deepEqual(unchanged.items, [existing]);
  const unique = addSpecificationOptions([], [entry, entry], blankItem);
  assert.equal(unique.added, 1);
  assert.equal(unique.items.length, 1);
});

test('reuses blank rows and their keys without changing the input array or copying quantities', () => {
  const empty = Object.freeze(blankItem({ key: 'keep-this-key' }));
  const existing = Object.freeze(blankItem({ name: '保留商品', quantity: '5', price: '9' }));
  const input = Object.freeze([empty, existing]);
  const result = addSpecificationOptions(input, [option()], blankItem);
  assert.equal(result.added, 1);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].key, 'keep-this-key');
  assert.equal(result.items[0].quantity, '');
  assert.equal(result.items[0].price, '1.234567');
  assert.equal(result.items[0].remark, '五层牛卡');
  assert.equal(result.items[1], existing);
  assert.equal(input[0], empty);
  assert.equal(input[0].specification, '');
});

test('does not overwrite rows containing a zero price, other price, remark, quantity, or product id', () => {
  const input = [
    blankItem({ price: '0' }), blankItem({ price: '1.25' }), blankItem({ remark: '仅备注' }),
    blankItem({ quantity: '0' }), blankItem({ product_id: 99 })
  ].map(Object.freeze);
  const original = input.map(item => ({ ...item }));
  Object.freeze(input);
  const result = addSpecificationOptions(input, [option()], blankItem);
  assert.equal(result.items.length, input.length + 1);
  assert.deepEqual(result.items.slice(0, input.length), original);
  assert.deepEqual(input, original);
});

test('capacity counts only occupied rows and allows filling exactly 200 entries', () => {
  assert.equal(MAX_PRINT_ITEMS, 200);
  assert.equal(availableSpecificationSlots([]), 200);
  assert.equal(availableSpecificationSlots([blankItem(), blankItem()]), 200);
  assert.equal(availableSpecificationSlots([blankItem({ price: '0' }), blankItem({ remark: '保留' }), blankItem()]), 198);
  const result = addSpecificationOptions(occupiedItems(199), [option()], blankItem);
  assert.equal(result.added, 1);
  assert.equal(result.items.length, 200);
  assert.equal(availableSpecificationSlots(result.items), 0);
  const withBlank = [...occupiedItems(199), blankItem({ key: 'last-blank' })];
  const filled = addSpecificationOptions(withBlank, [option()], blankItem);
  assert.equal(filled.items.length, 200);
  assert.equal(filled.items[199].key, 'last-blank');
  assert.equal(availableSpecificationSlots(occupiedItems(201)), 0);
});

test('duplicates remain a no-op at capacity instead of causing an overflow error', () => {
  const entry = option();
  const input = [...occupiedItems(199), itemFor(entry)];
  const result = addSpecificationOptions(input, [entry, entry], blankItem);
  assert.equal(result.added, 0);
  assert.deepEqual(result.items, input);
});

test('overflow after a partial batch throws without mutating the original rows or array', () => {
  const input = occupiedItems(198);
  input.push(blankItem({ key: 'blank-survives-failure' }));
  input.forEach(Object.freeze);
  Object.freeze(input);
  const original = input.map(item => ({ ...item }));
  const entries = [1, 2, 3].map(id => option({ id: `option-${id}`, specification: `${id}×900×800` }));
  assert.throws(() => addSpecificationOptions(input, entries, blankItem), /最多添加 200 项/);
  assert.deepEqual(input, original);
  assert.equal(input[198].specification, '');
  const full = occupiedItems(200);
  assert.throws(() => addSpecificationOptions(full, [option()], blankItem), /最多添加 200 项/);
  assert.equal(full.length, 200);
});
