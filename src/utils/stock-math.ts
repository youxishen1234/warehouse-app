export { roundDecimal, numberValue, lineAmount, dimensions, localDate } from '../../backend/stock-math';

import { lineAmount } from '../../backend/stock-math';
export function previewAmount(quantity: string, price: string): number {
  const q = Number(quantity), p = Number(price);
  if (!Number.isFinite(q) || !Number.isFinite(p) || q < 0 || p < 0) return 0;
  try { return lineAmount(q, p); } catch { return 0; }
}
