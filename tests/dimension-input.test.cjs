const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve('src/utils/dimension-input.ts');
const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths;
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const { formatDimensionInput: format, maxDimensionSides, resolveDimensionGroup, startDimensionGroup } = loaded.exports;

// Type the digits one at a time, exactly as the input field receives them.
const type = (digits, options) => { let value = ''; for (const digit of digits) value = format(value + digit, value, options); return value; };
const carton = { kind: '成品', sizeUnit: 'cm' }, board = { kind: '纸板', sizeUnit: 'cm' };
test('two-digit sides close as soon as each side is complete', () => {
  assert.equal(type('403020', carton), '40×30×20');
  assert.equal(format('40', '4', carton), '40×');
  assert.equal(format('40×3', '40×', carton), '40×3');
});
test('a run that does not fit the allowed sides groups by more digits instead', () => {
  assert.equal(type('400300200', carton), '400×300×200', 'nine digits is not five sides of two');
  assert.equal(type('400300', carton), '40×03×00', 'ambiguous while typing; settles as more digits arrive');
  // 1000500 is a real board, but under 成品 a third side is allowed and 100·050·0 fits, so it
  // stays three-sided. Nothing in the digits says which was meant; the user picks 纸板 or edits it.
  assert.equal(type('1000500', carton), '100×050×0');
  assert.equal(type('1000500', { kind: '纸板', sizeUnit: 'cm' }), '1000×500', '纸板 has only two sides, so it widens');
});
test('every size this app actually stores round-trips to itself', () => {
  const real = [['403020', '40×30×20', '成品'], ['400300200', '400×300×200', '成品'], ['300200150', '300×200×150', '成品'],
    ['404030', '40×40×30', '成品'], ['1550705', '1550×705', '纸板'], ['1000500', '1000×500', '纸板'], ['800400', '800×400', '纸板']];
  for (const [digits, expected, kind] of real) assert.equal(type(digits, { kind, sizeUnit: 'cm' }), expected, kind + ' ' + digits);
});
test('纸板 is length × width only, so it groups by wider sides', () => {
  assert.equal(maxDimensionSides('纸板'), 2);
  assert.equal(maxDimensionSides('成品'), 3);
  assert.equal(type('400300', board), '400×300');
  assert.equal(type('1550705', board), '1550×705');
  assert.equal(type('1000500', board), '1000×500');
});
test('尺寸单位 mm starts on three digits because the numbers are larger', () => {
  assert.equal(startDimensionGroup('mm'), 3);
  assert.equal(startDimensionGroup('cm'), 2);
  assert.equal(type('400×300×200'.replace(/×/g, ''), { kind: '成品', sizeUnit: 'mm' }), '400×300×200');
});
test('separators the user deleted stay deleted so a side can be corrected', () => {
  assert.equal(format('40', '40×'), '40');
  assert.equal(format('40×300', '40×300×'), '40×300');
  assert.equal(format('', '40×'), '');
  assert.equal(resolveDimensionGroup('4030', carton), 2, 'deleting back down does not inflate the group');
});
test('pasted dimensions in any separator style are normalized', () => {
  assert.equal(format('40x30*20', '', carton), '40×30×20');
  assert.equal(format('400＊300乘200', '', carton), '400×300×200');
  assert.equal(format('400mm×300mm', '', { kind: '成品', sizeUnit: 'mm' }), '400×300×');
});
test('free text typed into the size field is left untouched', () => {
  assert.equal(format('40×30×20 cm', '', carton), '40×30×20 cm');
  assert.equal(format('定制尺寸另议', '', carton), '定制尺寸另议');
});
