const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  matchingCustomerSpecifications,
  matchingProductsForSpecification,
  uniqueCustomerSpecification,
  validatedCustomerSpecification,
  customerSpecificationText,
  customerSpecificationDimensions
} = require('../src/features/carton-inbound/customer-pricing');

const customer = {
  id: 7,
  name: '客户甲',
  specs: [
    { id: 'a', goods: 'A楞箱', specification: '40×30×20 cm', material: 'AB', unit: '个', price: 0 },
    { id: 'b', goods: 'B楞箱', specification: '400×300×200 mm', material: 'BC', unit: '个', price: 12.5 },
    { id: 'duplicate', goods: '另一报价', specification: '40x30x20cm', material: 'AB', unit: '个', price: 13 }
  ]
};

const product = (overrides = {}) => ({
  id: 1,
  name: '库存纸箱',
  category: '纸箱',
  specification: '40*30*20',
  material: 'ab',
  unit: '个',
  ...overrides
});

test('客户纸箱规格按三维尺寸、材质及库存单位匹配，零客户价仍是有效报价', () => {
  const matches = matchingCustomerSpecifications(customer, product());
  assert.deepEqual(matches.map(spec => spec.id), ['a', 'duplicate']);
  assert.equal(uniqueCustomerSpecification(customer, product()), null, '同商品存在多条有效报价时不自动猜选');
  assert.equal(uniqueCustomerSpecification(customer, product({ material: 'BC' })).id, 'b');
  assert.equal(matchingProductsForSpecification(customer, [product(), product({ id: 2, material: 'BC' })], 'a').length, 1);
  assert.equal(matches[0].price, 0);
});

test('材质或库存单位不同不匹配；客户规格文案兼容旧尺寸字段', () => {
  assert.deepEqual(matchingCustomerSpecifications(customer, product({ material: 'A' })), []);
  assert.deepEqual(matchingCustomerSpecifications(customer, product({ unit: '箱' })), []);
  assert.equal(customerSpecificationText({ id: 'legacy', goods: '旧', size: '400×300×200', sizeUnit: 'mm', material: '', unit: '个', price: 2 }), '400×300×200 mm');
});

test('刷新报价时保留有效零价；规格被删除或商品不再匹配时视为失效', () => {
  assert.equal(validatedCustomerSpecification(customer, product(), 'a').price, 0);
  assert.equal(validatedCustomerSpecification(customer, null, 'a').id, 'a');
  assert.equal(validatedCustomerSpecification(customer, product(), 'deleted'), null);
  assert.equal(validatedCustomerSpecification(customer, product({ material: 'XY' }), 'a'), null);
});

test('纸板及非三维商品不能作为客户纸箱报价匹配', () => {
  assert.deepEqual(matchingCustomerSpecifications(customer, product({ category: '纸板' })), []);
  assert.deepEqual(matchingCustomerSpecifications(customer, product({ specification: '40×30' })), []);
});

test('没有报价的客户规格仍可选择，但不会被当成零价报价', () => {
  const unpriced = { ...customer, specs: [{ ...customer.specs[0], price: null }] };
  assert.equal(validatedCustomerSpecification(unpriced, null, 'a').price, null);
  assert.equal(uniqueCustomerSpecification(unpriced, product()).price, null);
  assert.equal(validatedCustomerSpecification(unpriced, product({ material: 'different' }), 'a'), null);
});

test('客户规格面积按物理单位换算为毫米，不将厘米当成毫米', () => {
  assert.deepEqual(customerSpecificationDimensions(customer.specs[0]), [400, 300]);
  assert.deepEqual(customerSpecificationDimensions(customer.specs[1]), [400, 300]);
  assert.deepEqual(customerSpecificationDimensions({ size: '40x30x20', sizeUnit: 'cm' }), [400, 300]);
  assert.deepEqual(customerSpecificationDimensions(null), [0, 0]);
});
