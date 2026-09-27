// Shared by the API and both stock forms so previews and persisted amounts agree.
function roundDecimal(value, places) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON * Math.max(1, Math.abs(value))) * factor) / factor;
}

function numberValue(value, label, positive = false) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new Error(`${label}无效，必须是数字`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (positive && number === 0) || number > Number.MAX_SAFE_INTEGER / 1000000) {
    throw new Error(`${label}无效，必须是${positive ? '正' : '非负'}数`);
  }
  if (Math.abs(number - roundDecimal(number, 6)) > Math.max(1, number) * Number.EPSILON) {
    throw new Error(`${label}无效，最多支持六位小数`);
  }
  return number;
}

function lineAmount(quantity, price) {
  const value = quantity * price;
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100) throw new Error('金额超出支持范围');
  return roundDecimal(value, 2);
}

function dimensions(specification, product = {}) {
  const match = String(specification || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)/);
  if (Number(product.length) > 0 && Number(product.width) > 0) return [Number(product.length), Number(product.width)];
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

module.exports = { roundDecimal, numberValue, lineAmount, dimensions, localDate };
