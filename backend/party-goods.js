'use strict';

// Quotes are editable reference data, not posted inventory or accounting rows.
// Missing values must remain missing until a receipt explicitly supplies them.
const BOARD_NUMBERS = ['boardLength', 'boardWidth', 'cartonLength', 'cartonWidth', 'cartonHeight', 'layers', 'faceGsm', 'linerGsm', 'flutingGsm'];
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
function validate(specs, label = '常用货物') {
  if (!Array.isArray(specs) || specs.length > 500) fail(`${label}资料无效`);
  const seen = new Set();
  return specs.map(spec => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.id !== 'string' || !spec.id.trim() || spec.id.length > 180) fail(`${label}资料无效`);
    const id = spec.id.trim();
    if (seen.has(id)) fail(`${label}编号重复`);
    seen.add(id);
    const text = (field, max = 100) => {
      const value = spec[field];
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > max)) fail(`${label}${field}格式无效`);
      return String(value ?? '').trim();
    };
    const optionalPrice = (value, field) => {
      if (value === undefined || value === null || value === '') return null;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e8) fail(`${label}${field}无效`);
      return value;
    };
    const result = { id, goods: text('goods'), specification: text('specification'), material: text('material'), unit: text('unit', 10), price: optionalPrice(spec.price, '单价') };
    if (spec.category !== undefined) {
      if (!['纸箱', '纸板', '其他'].includes(spec.category)) fail(`${label}类别无效`);
      result.category = spec.category;
    }
    if (spec.kind !== undefined) {
      if (!['成品', '纸箱', '纸板', '其他'].includes(spec.kind)) fail(`${label}类别无效`);
      result.kind = spec.kind;
    }
    if (spec.dimension_source !== undefined) {
      const source = spec.dimension_source;
      if (!source || typeof source !== 'object' || Array.isArray(source)
        || typeof source.customer_id !== 'string' || !source.customer_id.trim() || source.customer_id.length > 80
        || typeof source.spec_id !== 'string' || !source.spec_id.trim() || source.spec_id.length > 80
        || !Object.keys(source).every(key => key === 'customer_id' || key === 'spec_id')) fail('客户尺寸本关联无效');
      result.dimension_source = { customer_id: source.customer_id.trim(), spec_id: source.spec_id.trim() };
    }
    for (const field of BOARD_NUMBERS) {
      const value = spec[field];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e8 || (field === 'layers' && ![2, 3, 5, 7].includes(value))) fail(`${label}纸板规格无效`);
      result[field] = value;
    }
    if (spec.fluteType !== undefined) {
      const flute = text('fluteType', 12).toUpperCase();
      if (flute && !/^[A-Z]{1,4}$/.test(flute)) fail(`${label}楞型无效`);
      result.fluteType = flute;
    }
    if (spec.unitPrice !== undefined) result.unitPrice = optionalPrice(spec.unitPrice, '采购单价');
    const hasDetails = [result.goods, result.specification, result.material, result.unit].some(Boolean)
      || result.price !== null || BOARD_NUMBERS.some(field => Number(result[field]) > 0)
      || Boolean(result.fluteType) || result.unitPrice != null;
    if (!hasDetails) fail(`${label}至少填写货物名称、尺寸、材质、单位或单价中的一项，不能保存完全空白记录`);
    return result;
  });
}

function profile(raw, label, partial = false) {
  if (!partial || raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !raw.name.trim()) fail(`${label}名称不能为空`);
  }
  const limits = { name: 50, contact: 50, phone: 20, address: 200, remark: 500 };
  const result = {};
  for (const [field, max] of Object.entries(limits)) {
    if (raw[field] === undefined) continue;
    if (raw[field] !== null && (typeof raw[field] !== 'string' || raw[field].length > max)) fail(`${label}${field}格式无效`);
    result[field] = String(raw[field] ?? '').trim();
  }
  return result;
}

module.exports = { validate, profile };
