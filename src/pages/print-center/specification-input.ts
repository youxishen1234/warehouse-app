import { normalizeSpecification } from '../../../backend/print-notes';

// Deleting remains possible without reinserting a separator. Completed dimensions stay intact.
export function formatSpecificationInput(value: string, previous = '', digits: 2 | 3 = 3): string {
  const normalized = normalizeSpecification(value);
  if (value.length < previous.length || !/^[0-9×]*$/.test(normalized)) return normalized;
  const parts = normalized.split('×');
  let last = parts.pop() || '';
  while (parts.length < 2 && last.length >= digits) {
    parts.push(last.slice(0, digits));
    last = last.slice(digits);
  }
  return [...parts, last].join('×');
}
