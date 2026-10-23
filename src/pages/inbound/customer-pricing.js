'use strict';

const { findCustomerSpecification, matchCustomerSpecification } = require('../../../backend/production-pricing');

function matchesSpecification(customer, product, specId) {
  try {
    return matchCustomerSpecification(customer, product, specId).specification;
  } catch {
    return null;
  }
}

function matchingCustomerSpecifications(customer, product) {
  if (!customer || !product) return [];
  return (Array.isArray(customer.specs) ? customer.specs : [])
    .map(spec => matchesSpecification(customer, product, String(spec?.id ?? '')))
    .filter(Boolean);
}

function matchingProductsForSpecification(customer, products, specId) {
  if (!customer || !Array.isArray(products)) return [];
  return products.filter(product => matchesSpecification(customer, product, specId));
}

function uniqueCustomerSpecification(customer, product) {
  const matches = matchingCustomerSpecifications(customer, product);
  return matches.length === 1 ? matches[0] : null;
}

function validatedCustomerSpecification(customer, product, specId) {
  const specification = findCustomerSpecification(customer, specId);
  if (!specification || typeof specification.price !== 'number' || !Number.isFinite(specification.price) || specification.price < 0) return null;
  if (!product) return specification;
  return matchesSpecification(customer, product, specId);
}

function customerSpecificationText(specification) {
  if (!specification) return '';
  return String(specification.specification ?? (
    specification.size ? `${specification.size} ${specification.sizeUnit || 'cm'}` : ''
  )).trim();
}

module.exports = {
  matchingCustomerSpecifications,
  matchingProductsForSpecification,
  uniqueCustomerSpecification,
  validatedCustomerSpecification,
  customerSpecificationText
};
