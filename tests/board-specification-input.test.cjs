const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function loadTypeScript(relativePath) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(outputText, filename);
  return loaded.exports;
}

const {
  parseDimensionSpecification,
  preserveDimensionGrouping,
  shouldPreserveDimensionGrouping,
  specificationFromDimensions,
} = loadTypeScript('src/pages/board-receive/specification-input.ts');
const { formatSpecificationInput } = loadTypeScript('src/pages/print-center/specification-input.ts');

test('board input inserts two-digit separators for two and three dimensions', () => {
  assert.equal(formatSpecificationInput('3020', '', 2), '30×20');
  assert.equal(formatSpecificationInput('302015', '', 3), '30×20×15');
  assert.equal(formatSpecificationInput('30', '', 2), '30×');
});

test('board specification parsing accepts exactly the expected positive dimensions', () => {
  assert.deepEqual(parseDimensionSpecification('30×20', 2), [30, 20]);
  assert.deepEqual(parseDimensionSpecification('30.5×20.25', 2), [30.5, 20.25]);
  assert.deepEqual(parseDimensionSpecification('30×20×15', 3), [30, 20, 15]);
  for (const invalid of ['', '30×', '0×20', '-1×20', '30×20×15']) {
    assert.equal(parseDimensionSpecification(invalid, 2), null, invalid);
  }
  for (const invalid of ['', '30×20', '30×20×15×10', '30×0×15']) {
    assert.equal(parseDimensionSpecification(invalid, 3), null, invalid);
  }
});

test('historical wide and decimal sizes remain grouped when loaded or edited', () => {
  assert.equal(specificationFromDimensions([160, 110]), '160×110');
  assert.equal(specificationFromDimensions([30.5, 20.25, 15]), '30.5×20.25×15');
  assert.equal(shouldPreserveDimensionGrouping('161×110', '160×110'), true);
  assert.equal(preserveDimensionGrouping('161×110'), '161×110');
  assert.equal(shouldPreserveDimensionGrouping('160×110', '30×20'), true);
  assert.equal(shouldPreserveDimensionGrouping('30×201', '30×20'), false);
  assert.equal(formatSpecificationInput('30×201', '30×20', 2), '30×20×1');
  assert.equal(shouldPreserveDimensionGrouping('302015', ''), false);
});
