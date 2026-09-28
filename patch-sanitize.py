from pathlib import Path
p=Path('backend/stock-math.js')
s=p.read_text(encoding='utf-8')
if 'function sanitizeDecimalInput' not in s:
 s=s.replace("module.exports = { roundDecimal, numberValue, lineAmount, dimensions, localDate };", """function sanitizeDecimalInput(value, maxDecimals = 6) {
  const raw = String(value ?? '').replace(/[^0-9.]/g, '');
  if (!raw) return '';
  const pieces = raw.split('.');
  const integer = pieces.shift() || '';
  const decimal = pieces.join('').slice(0, Math.max(0, maxDecimals));
  return pieces.length ? `${integer || '0'}.${decimal}` : integer;
}

module.exports = { roundDecimal, numberValue, lineAmount, dimensions, localDate, sanitizeDecimalInput };""")
 p.write_text(s,encoding='utf-8')
p=Path('backend/stock-math.d.ts')
s=p.read_text(encoding='utf-8')
if 'sanitizeDecimalInput' not in s: p.write_text(s+'export function sanitizeDecimalInput(value: unknown, maxDecimals?: number): string;\n',encoding='utf-8')
p=Path('src/utils/stock-math.ts')
s=p.read_text(encoding='utf-8')
s=s.replace('export { roundDecimal, numberValue, lineAmount, dimensions, localDate }', 'export { roundDecimal, numberValue, lineAmount, dimensions, localDate, sanitizeDecimalInput }')
p.write_text(s,encoding='utf-8')
