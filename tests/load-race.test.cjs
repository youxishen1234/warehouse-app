const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('stock workflow pages guard stale responses and initial duplicate refreshes', () => {
  const pages = [
    'src/pages/home/index.tsx',
    'src/pages/inbound/index.tsx',
    'src/pages/outbound/index.tsx',
    'src/pages/records/index.tsx',
    'src/pages/orders/index.tsx'
  ];
  for (const file of pages) {
    const source = read(file);
    assert.match(source, /useRef\(0\)/, `${file} should keep a request sequence ref`);
    assert.match(source, /loadSequence|requestId/, `${file} should identify each load`);
    assert.match(source, /!== (?:loadSequence|requestId)\.current/, `${file} should discard stale responses`);
  }
  for (const file of ['src/pages/home/index.tsx', 'src/pages/inbound/index.tsx', 'src/pages/outbound/index.tsx']) {
    const source = read(file);
    assert.match(source, /didShowOnce/, `${file} should dedupe first useDidShow refresh`);
    assert.match(source, /Date\.now\(\) - lastLoadAt\.current >= 250/, `${file} should gate first refresh`);
  }
  for (const file of ['src/pages/records/index.tsx', 'src/pages/orders/index.tsx']) {
    const source = read(file);
    assert.match(source, /lastLoadAt/, `${file} should gate repeated refreshes`);
    assert.match(source, /startedAt - lastLoadAt\.current < 250/, `${file} should suppress same-tick reloads`);
  }
});

test('sequence guard keeps the newest refresh result when an older request resolves last', async () => {
  let sequence = 0;
  let state = '';
  const resolve = (value, delay) => new Promise(done => setTimeout(() => done(value), delay));
  const load = async (value, delay) => {
    const current = ++sequence;
    const result = await resolve(value, delay);
    if (current !== sequence) return;
    state = result;
  };
  const oldRequest = load('old-response', 40);
  const newRequest = load('new-response', 5);
  await Promise.all([oldRequest, newRequest]);
  assert.equal(state, 'new-response');
});
