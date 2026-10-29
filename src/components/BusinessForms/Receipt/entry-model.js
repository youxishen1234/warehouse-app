'use strict';

const { dimensionsInCm } = require('../../../../backend/production-pricing');
const { lineAmount: calculateAmount, roundDecimal } = require('../../../../backend/stock-math');
const normalized = value => String(value ?? '').trim().replace(/\s+/g, '').toLowerCase();

function sameSize(left, right) {
  const a = dimensionsInCm(left || '', 'cm'), b = dimensionsInCm(right || '', 'cm');
  if (a && b) return a.length === b.length && a.every((value, i) => value === b[i]);
  return Boolean(normalized(left)) && normalized(left) === normalized(right);
}

function completeGood(item) {
  return Boolean(item && String(item.goods || '').trim() && String(item.specification || '').trim()
    && String(item.material || '').trim() && String(item.unit || '').trim()
    && (item.unitPrice ?? item.price) != null && Number.isFinite(Number(item.unitPrice ?? item.price)) && Number(item.unitPrice ?? item.price) >= 0);
}

function matchingProducts(item, products, cartonOnly = false) {
  if (cartonOnly && item?.category && item.category !== '纸箱') return [];
  if (!item || !item.specification || !item.material || !item.unit) return [];
  return products.filter(product => !product.deleted_at && (!cartonOnly || product.category !== '纸板')
    && sameSize(item.specification, product.specification)
    && normalized(item.material) === normalized(product.material)
    && normalized(item.unit) === normalized(product.unit));
}

function lineAmount(line) {
  if (!String(line.unit_price ?? '').trim() || !String(line.delivered_qty ?? '').trim()) return null;
  const quantity = Number(line.delivered_qty), price = Number(line.unit_price);
  if (!Number.isFinite(quantity) || !Number.isFinite(price) || quantity < 0 || price < 0) return NaN;
  try { return calculateAmount(quantity, price); } catch { return NaN; }
}

function draftTotal(lines) {
  const amounts = lines.map(lineAmount).filter(value => value !== null);
  return amounts.length ? (amounts.every(Number.isFinite) ? roundDecimal(amounts.reduce((sum, value) => sum + value, 0), 2) : NaN) : null;
}

module.exports = { completeGood, matchingProducts, lineAmount, draftTotal };
