const assert = require('node:assert/strict');
const { test } = require('node:test');
const { completeGood, matchingProducts, lineAmount, draftTotal } = require('../src/components/BusinessForms/Receipt/entry-model');

const good = overrides => ({ goods: '客户货号甲', specification: '30×20×15 cm', material: 'AB', unit: '个', price: 2.5, ...overrides });
const products = [{ id: 4, name: '库存商品乙', category: '纸箱', specification: '300×200×150 mm', material: 'ab', unit: '个', price: 1, stock: 0 }];

test('a name-only party good is retained as incomplete and an exact physical item maps without name equality', () => {
  assert.equal(completeGood({ goods: '客户货号甲' }), false);
  assert.equal(matchingProducts(good(), products, true).length, 1);
  assert.equal(matchingProducts(good({ material: '' }), products, true).length, 0);
});

test('empty prices never produce zero and totals include only explicitly priced quantities', () => {
  assert.equal(lineAmount({ delivered_qty: '8', unit_price: '' }), null);
  assert.equal(draftTotal([{ delivered_qty: '8', unit_price: '' }, { delivered_qty: '2', unit_price: '3.25' }]), 6.5);
  assert.equal(draftTotal([{ delivered_qty: '', unit_price: '' }]), null);
});

test('physical dimensions, material and stock unit all have to agree before automatic mapping', () => {
  assert.equal(matchingProducts(good(), products, true).length, 1);
  assert.equal(matchingProducts(good({ material: 'different' }), products, true).length, 0);
  assert.equal(matchingProducts(good(), [{ ...products[0], unit: '箱' }], true).length, 0);
  assert.equal(matchingProducts(good(), [{ ...products[0], specification: '300×200×100 mm' }], true).length, 0);
  assert.equal(matchingProducts(good({ category: '其他' }), products, true).length, 0);
});
