'use strict';

const normalizeText = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, '').toLocaleLowerCase('en-US');

function dimensionsInCm(specification, dimensionUnit = 'cm') {
  const text = String(specification ?? '').trim();
  const dimension = '(\\d+(?:\\.\\d+)?)\\s*(mm|cm|毫米|厘米)?';
  const separator = '[×xX*＊]';
  const match = new RegExp(`^${dimension}\\s*${separator}\\s*${dimension}(?:\\s*${separator}\\s*${dimension})?\\s*(mm|cm|毫米|厘米)?$`, 'i').exec(text);
  if (!match) return null;
  const globalUnit = match[7] || match[6] || match[4] || match[2] || String(dimensionUnit || 'cm').trim();
  const values = [];
  for (const [value, explicitUnit] of [[match[1], match[2]], [match[3], match[4]], [match[5], match[6]]]) {
    if (value === undefined) continue;
    const unit = explicitUnit || globalUnit;
    const scale = /^(mm|毫米)$/i.test(unit) ? 0.1 : /^(cm|厘米)$/i.test(unit) ? 1 : null;
    if (scale === null) return null;
    values.push(Math.round(Number(value) * scale * 1e6) / 1e6);
  }
  return values.length >= 2 && values.every(value => Number.isFinite(value) && value > 0 && value <= 1e8) ? values : null;
}

function findCustomerSpecification(customer, specId) {
  if (!customer || customer.deleted_at) return null;
  if (typeof specId !== 'string' || !specId.trim()) return null;
  return (Array.isArray(customer.specs) ? customer.specs : []).find(spec => spec?.id === specId) || null;
}

function matchCustomerSpecification(customer, product, specId) {
  if (!customer || customer.deleted_at) throw new Error('客户不存在或已停用，请刷新');
  const specification = findCustomerSpecification(customer, specId);
  if (!specification) throw new Error('客户规格已变更，请刷新后重新选择');
  if (!product || product.deleted_at || product.category === '纸板') throw new Error('请选择有效纸箱商品');
  const productDimensions = dimensionsInCm(product.specification, product.size_unit || 'cm');
  const customerDimensions = dimensionsInCm(specification.specification ?? specification.size, specification.sizeUnit || 'cm');
  if (!productDimensions || productDimensions.length !== 3 || !customerDimensions || customerDimensions.length !== 3
    || productDimensions.some((value, index) => value !== customerDimensions[index])) {
    throw new Error('客户规格尺寸与所选纸箱商品不匹配');
  }
  if (normalizeText(product.unit) !== normalizeText(specification.unit)) {
    throw new Error('客户规格单位与所选纸箱商品单位不匹配');
  }
  if (normalizeText(product.material) !== normalizeText(specification.material)) {
    throw new Error('客户规格材质与所选纸箱商品材质不匹配');
  }
  if (typeof specification.price !== 'number' || !Number.isFinite(specification.price) || specification.price < 0) {
    throw new Error('客户规格单价无效，请先更新客户资料');
  }
  return {
    specification,
    dimensionsCm: customerDimensions,
    snapshot: {
      id: specification.id,
      goods: String(specification.goods || ''),
      specification: String(specification.specification ?? specification.size ?? ''),
      material: String(specification.material || ''),
      unit: String(specification.unit || ''),
      price: specification.price
    }
  };
}

module.exports = { dimensionsInCm, findCustomerSpecification, matchCustomerSpecification };
