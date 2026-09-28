import { MAX_QUANTITY_VALUE, roundDecimal, sanitizeDecimalInput } from '@/utils/stock-math';

export type DimensionMode = 'inner' | 'outer';

export function parseDimension(value: string): number | null {
  if (!value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function calculateTargetDimension(value: number, thickness: number, mode: DimensionMode): number {
  const target = mode === 'inner' ? value + thickness * 2 : value - thickness * 2;
  return roundDecimal(target, 6);
}

export function formatDimension(value: number): string {
  return roundDecimal(value, 2).toString();
}

export function sanitizeDimensionInput(value: string): string {
  const sanitized = sanitizeDecimalInput(value, 6);
  if (!sanitized) return '';
  const numeric = Number(sanitized);
  return Number.isFinite(numeric) && numeric <= MAX_QUANTITY_VALUE ? sanitized : '';
}
