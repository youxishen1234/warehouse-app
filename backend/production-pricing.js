'use strict';

const normalizeText = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, '').toLocaleLowerCase('en-US');
const normalizeCustomerName = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');

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

function canonicalSpecification(value, dimensionUnit = 'cm') {
  const text = String(value ?? '').trim();
  const dimensions = dimensionsInCm(text, dimensionUnit);
  if (!dimensions || dimensions.length !== 3) return null;
  if (/(?:mm|cm|毫米|厘米)/i.test(text)) return text;
  const rawUnit = String(dimensionUnit || 'cm').trim();
  const unit = /^(mm|毫米)$/i.test(rawUnit) ? 'mm' : /^(cm|厘米)$/i.test(rawUnit) ? 'cm' : null;
  return unit ? `${text} ${unit}` : null;
}

function specificationIdentity(specification) {
  const dimensions = dimensionsInCm(specification.specification, 'cm');
  if (!dimensions || dimensions.length !== 3) return null;
  return JSON.stringify([
    normalizeText(specification.goods),
    normalizeText(specification.material),
    normalizeText(specification.unit),
    dimensions
  ]);
}

function dimensionSpecId(customerId, specId) {
  return `dimension:${JSON.stringify([String(customerId), String(specId)])}`;
}

function mergeCustomerCartonSpecifications(customer, customers, dimensions) {
  if (!customer || customer.deleted_at) return [];
  const accountSpecs = Array.isArray(customer.specs) ? customer.specs : [];
  const reservedIds = new Set(accountSpecs.map(spec => String(spec?.id ?? '')));
  const result = [];
  const accountIdentities = new Set();
  for (const spec of accountSpecs) {
    if (!spec || spec.kind === '纸板' || typeof spec.id !== 'string' || !spec.id.trim()) continue;
    const specification = canonicalSpecification(spec.specification ?? spec.size, spec.sizeUnit || 'cm');
    const price = spec.price === undefined ? null : spec.price;
    if (!specification || typeof spec.goods !== 'string' || !spec.goods.trim()
      || (price !== null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0))) continue;
    const canonical = {
      id: spec.id.trim(), goods: spec.goods.trim(), specification,
      material: String(spec.material ?? ''), unit: String(spec.unit ?? '').trim() || '个', price
    };
    result.push(canonical);
    const identity = specificationIdentity(canonical);
    if (identity) accountIdentities.add(identity);
  }

  const activeCustomers = (Array.isArray(customers) ? customers : []).filter(row => !row?.deleted_at);
  const customerName = normalizeCustomerName(customer.name);
  const sameNameCustomers = activeCustomers.filter(row => normalizeCustomerName(row?.name) === customerName);
  if (sameNameCustomers.length !== 1 || Number(sameNameCustomers[0].id) !== Number(customer.id)) return result;
  const dimensionCustomers = Array.isArray(dimensions?.customers) ? dimensions.customers : [];
  const matchingDimensionCustomers = dimensionCustomers.filter(row => normalizeCustomerName(row?.name) === customerName);
  const seenDimensionIdentities = new Set();
  const seenDimensionIds = new Set();
  for (const dimensionCustomer of matchingDimensionCustomers) {
    if (!Array.isArray(dimensionCustomer?.specs)) continue;
    for (const spec of dimensionCustomer.specs) {
      if (!spec || spec.kind === '纸板' || typeof spec.id !== 'string' || !spec.id.trim()) continue;
      const specification = canonicalSpecification(spec.size ?? spec.specification, spec.sizeUnit || 'cm');
      if (!specification) continue;
      // Some legacy dimensions entries predate the goods field; retain them under a stable label.
      const goods = String(spec.goods ?? '').trim() || '纸箱规格';
      const canonical = {
        id: dimensionSpecId(dimensionCustomer.id, spec.id),
        goods, specification, material: String(spec.material ?? ''),
        unit: String(spec.unit ?? '').trim() || '个', price: null
      };
      const identity = specificationIdentity(canonical);
      if (!identity || accountIdentities.has(identity) || seenDimensionIdentities.has(identity)
        || seenDimensionIds.has(canonical.id) || reservedIds.has(canonical.id)) continue;
      seenDimensionIdentities.add(identity);
      seenDimensionIds.add(canonical.id);
      result.push(canonical);
    }
  }
  return result;
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
  if (specification.price !== null && (typeof specification.price !== 'number'
    || !Number.isFinite(specification.price) || specification.price < 0)) {
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

module.exports = { dimensionsInCm, canonicalSpecification, dimensionSpecId, mergeCustomerCartonSpecifications, findCustomerSpecification, matchCustomerSpecification };
