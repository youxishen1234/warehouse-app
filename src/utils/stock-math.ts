export { roundDecimal, numberValue, lineAmount, dimensions, localDate, sanitizeDecimalInput } from '../../backend/stock-math';

export { QUANTITY_DECIMALS, MONEY_DECIMALS, AREA_DECIMALS, MAX_QUANTITY_VALUE, MAX_MONEY_VALUE } from '../../backend/stock-math';
import { lineAmount } from '../../backend/stock-math';
export function previewAmount(quantity: string, price: string): number {
  const q = Number(quantity), p = Number(price);
  if (!Number.isFinite(q) || !Number.isFinite(p) || q < 0 || p < 0) return 0;
  try { return lineAmount(q, p); } catch { return Number.NaN; }
}
