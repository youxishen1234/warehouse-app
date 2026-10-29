export type SpecificationDimensionCount = 2 | 3;

function normalizeDimensionSeparators(value: string): string {
  return String(value ?? '')
    .replace(/\s*(?:[×xX*＊✕]|乘)\s*/g, '×')
    .trim();
}

export function specificationFromDimensions(values: Array<string | number | null | undefined>): string {
  if (values.some(value => value == null || String(value).trim() === '')) return '';
  return values.map(value => String(value).trim()).join('×');
}

export function shouldPreserveDimensionGrouping(value: string, previous: string): boolean {
  const normalizedValue = normalizeDimensionSeparators(value);
  const normalizedPrevious = normalizeDimensionSeparators(previous);
  const hasWideDimension = (specification: string) => specification
    .split('×')
    .some(dimension => dimension.length > 2);
  const hasDecimalDimension = (specification: string) => specification
    .split('×')
    .some(dimension => dimension.includes('.'));

  if (!normalizedValue.includes('×')) return false;
  if (hasDecimalDimension(normalizedValue) || hasDecimalDimension(normalizedPrevious)) return true;
  if (hasWideDimension(normalizedPrevious)) return true;
  if (!normalizedPrevious && hasWideDimension(normalizedValue)) return true;

  // On a fresh short-dimension draft, a single appended digit belongs to the
  // next two-digit dimension. A full pasted wide size remains explicit.
  const singleCharacterAppend = normalizedValue.length === normalizedPrevious.length + 1
    && normalizedValue.startsWith(normalizedPrevious);
  return hasWideDimension(normalizedValue) && !singleCharacterAppend;
}

export function preserveDimensionGrouping(value: string): string {
  return normalizeDimensionSeparators(value);
}

export function parseDimensionSpecification(
  value: string,
  expectedDimensions: SpecificationDimensionCount,
): number[] | null {
  const normalized = normalizeDimensionSeparators(value);
  const dimensions = normalized.split('×');
  if (dimensions.length !== expectedDimensions || dimensions.some(dimension => !dimension)) return null;

  const parsed = dimensions.map(dimension => {
    const part = dimension.trim();
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(part)) return NaN;
    return Number(part);
  });
  if (parsed.some(dimension => !Number.isFinite(dimension) || dimension <= 0)) return null;
  return parsed;
}
