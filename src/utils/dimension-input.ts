import { normalizeSpecification } from '../../backend/print-notes';

/**
 * Side length a dimension is written down in: cartons are usually two digits per
 * side (40×30×20), boards three or four (400×300×200, 1550×705).
 */
export type DimensionGroup = 2 | 3 | 4;

export type DimensionOptions = { sizeUnit?: string; kind?: string };

/** Only digits and separators are a dimension; anything else typed into the field is free text. */
const isDimensionText = (value: string) => /^[0-9×]*$/.test(value);
const digitsOf = (value: string) => normalizeSpecification(value).replace(/[^0-9]/g, '');

/** mm means bigger numbers, so a finished carton in mm is written three digits a side. */
export const startDimensionGroup = (sizeUnit = 'cm'): DimensionGroup => (sizeUnit === 'mm' ? 3 : 2);

/** A board is length × width and a carton adds height: that caps how many sides a value can have. */
export const maxDimensionSides = (kind = '成品'): number => (kind === '纸板' ? 2 : 3);

const chunk = (digits: string, group: DimensionGroup) => digits.match(new RegExp('.{1,' + group + '}', 'g')) || [];

/**
 * Split into sides, and when that would need more sides than the value can have, group by more
 * digits instead: 400300200 is 40·03·00·20·0 five ways by two, so it resolves to 400×300×200,
 * while 403020 already fits in three sides and stays 40×30×20. The floor keeps a length the user
 * has already typed their way into, so deleting back down does not undo it.
 */
export function resolveDimensionGroup(digits: string, options: DimensionOptions = {}): DimensionGroup {
  const maxSides = maxDimensionSides(options.kind);
  let group: DimensionGroup = startDimensionGroup(options.sizeUnit);
  while (group < 4 && chunk(digits, group).length > maxSides) group = (group + 1) as DimensionGroup;
  return group;
}

/**
 * Insert the × between sides while digits are typed. A separator the user just deleted is never
 * put back, so a side stays correctable by hand, and text that is not a dimension is left alone.
 */
export function formatDimensionInput(value: string, previous = '', options: DimensionOptions = {}): string {
  const normalized = normalizeSpecification(value);
  if (!isDimensionText(normalized)) return normalized;
  if (normalized.length < previous.length) return normalized;
  const digits = digitsOf(normalized);
  if (!digits) return '';
  const group = resolveDimensionGroup(digits, options);
  const sides = chunk(digits, group);
  const result = sides.join('×');
  if (sides.length >= maxDimensionSides(options.kind)) return result;
  return result + (sides[sides.length - 1].length === group ? '×' : '');
}
