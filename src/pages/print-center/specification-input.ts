import { normalizeSpecification } from '../../../backend/print-notes';

// Three digits complete a dimension. Deleting remains possible without reinserting a separator.
export function formatSpecificationInput(value: string, previous = ''): string {
  const normalized = normalizeSpecification(value);
  if (value.length < previous.length || !/^[0-9×]*$/.test(normalized)) return normalized;
  const parts = normalized.split('×');
  const result = parts.map(part => (part.match(/.{1,3}/g) || []).join('×')).join('×');
  const dimensions = result.split('×');
  const last = dimensions[dimensions.length - 1];
  return result + (dimensions.length < 3 && last.length === 3 ? '×' : '');
}
