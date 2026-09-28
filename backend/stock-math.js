// Shared by the API and both stock forms so previews and persisted amounts agree.
// Numeric policy is declared once and reused by validation and formatting.
const QUANTITY_DECIMALS = 6;
const MONEY_DECIMALS = 2;
const AREA_DECIMALS = 4;
const MAX_QUANTITY_VALUE = Number.MAX_SAFE_INTEGER / (10 ** QUANTITY_DECIMALS);
const MAX_MONEY_VALUE = Number.MAX_SAFE_INTEGER / (10 ** MONEY_DECIMALS);

function roundDecimal(value, places) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON * Math.max(1, Math.abs(value))) * factor) / factor;
}

function numberValue(value, label, positive = false) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new Error(`${label}无效，必须是数字`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (positive && number === 0)) {
    throw new Error(`${label}无效，必须是${positive ? '正数' : '非负'}数`);
  }
  if (number > MAX_QUANTITY_VALUE) {
    throw new Error(`${label}数值过大，超出支持范围`);
  }
  if (Math.abs(number - roundDecimal(number, QUANTITY_DECIMALS)) > Math.max(1, number) * Number.EPSILON) {
    throw new Error(`${label}无效，最多支持六位小数`);
  }
  return number;
}
function lineAmount(quantity, price) {
  const value = quantity * price;
  if (!Number.isFinite(value) || Math.abs(value) > MAX_MONEY_VALUE) throw new Error('金额超出支持范围');
  return roundDecimal(value, MONEY_DECIMALS);
}

function dimensions(specification, product = {}) {
  const match = String(specification || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)/);
  if (Number(product.length) > 0 && Number(product.width) > 0) return [Number(product.length), Number(product.width)];
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function sanitizeDecimalInput(value, maxDecimals = 6) {
  const source = String(value ?? '');
  const exponentOrHex = source.search(/[eExX]/);
  const raw = (exponentOrHex >= 0 ? source.slice(0, exponentOrHex) : source).replace(/[^0-9.]/g, '');
  if (!raw) return '';
  const pieces = raw.split('.');
  const integer = pieces.shift() || '';
  const decimal = pieces.join('').slice(0, Math.max(0, maxDecimals));
  return pieces.length ? `${integer || '0'}.${decimal}` : integer;
}

module.exports = { roundDecimal, numberValue, lineAmount, dimensions, localDate, sanitizeDecimalInput, QUANTITY_DECIMALS, MONEY_DECIMALS, AREA_DECIMALS, MAX_QUANTITY_VALUE, MAX_MONEY_VALUE };
