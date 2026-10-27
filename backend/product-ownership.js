'use strict';

function productOwnerId(product) {
  const value = product?.customer_id;
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('商品的客户归属编号无效');
  return id;
}

function assertProductCustomer(product, customerId, label = '商品') {
  const ownerId = productOwnerId(product);
  if (ownerId === null) return null;
  const partyId = customerId === undefined || customerId === null || customerId === '' ? null : Number(customerId);
  if (!Number.isSafeInteger(partyId) || partyId <= 0 || partyId !== ownerId) {
    throw new Error(`${label}属于客户专属纸箱，不能用于其他客户或未关联客户的业务`);
  }
  return ownerId;
}

module.exports = { productOwnerId, assertProductCustomer };
