import { MAX_QUANTITY_VALUE, numberValue, roundDecimal, sanitizeDecimalInput } from '../../backend/stock-math';

/** Sanitize balance/amount fields without turning a negative paste into a positive value. */
export function sanitizeNonNegativeMoneyInput(value: string): string {
  const source = String(value ?? '');
  if (/[-+eExX]/.test(source)) return '';
  const sanitized = sanitizeDecimalInput(source, 2);
  if (!sanitized) return '';
  const amount = Number(sanitized);
  return Number.isFinite(amount) && amount <= MAX_QUANTITY_VALUE ? sanitized : '';
}

/** Parse the exact value shared by an amount preview and the write payload. */
export function parseMoneyInput(value: string, label = '\u91d1\u989d', positive = false): number {
  const sanitized = sanitizeNonNegativeMoneyInput(value);
  if (!sanitized) throw new Error(`${label}\u65e0\u6548\uff0c\u8bf7\u8f93\u5165\u975e\u8d1f\u91d1\u989d\uff0c\u6700\u591a\u4e24\u4f4d\u5c0f\u6570`);
  return roundDecimal(numberValue(sanitized, label, positive), 2);
}

/** Preview helper uses the same validation and rounding as submission. */
export function previewMoneyInput(value: string): number | null {
  if (!sanitizeNonNegativeMoneyInput(value)) return null;
  try { return parseMoneyInput(value, '\u91d1\u989d', true); } catch { return null; }
}
