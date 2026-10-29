import { normalizeSpecification } from '../../../backend/print-notes';

// Two digits complete a dimension. Deleting remains possible without reinserting a separator.
export function formatSpecificationInput(value: string, previous = '', dimensionCount: 2 | 3 = 3): string {
  const normalized = normalizeSpecification(value);
  if (value.length < previous.length || !/^[0-9×]*$/.test(normalized)) return normalized;
  const parts = normalized.split('×');
  const result = parts.map(part => (part.match(/.{1,2}/g) || []).join('×')).join('×');
  const dimensions = result.split('×');
  const last = dimensions[dimensions.length - 1];
  return result + (dimensions.length < dimensionCount && last.length === 2 ? '×' : '');
}
