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
    'src/pages/outbound/index.tsx'
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
});

test('orders and records use the shared sequence guard without fabricated successful reloads', () => {
  const source = read('src/pages/orders/index.tsx');
  const hook = read('src/hooks/useRemoteData.ts');
  assert.ok(source.includes('const loadOrders = useCallback(async () => {'));
  assert.ok(source.includes('useRemoteData(loadOrders,'));
  assert.ok(hook.includes('const sequence = useRef(0)'));
  assert.ok(hook.includes('const current = ++sequence.current'));
  assert.ok(hook.includes('if (!mounted.current || current !== sequence.current) return;'));
  assert.ok(!source.includes('useEffect(() => { load(); }, [load])'), 'the hook already owns initial loading');
  const records = read('src/pages/records/index.tsx');
  assert.ok(records.includes('useRemoteData(loadRecords,'));
  assert.ok(records.includes('getTransactions('));
  assert.ok(!records.includes('return { list: [], products: [] }'), 'a refresh must not replace an API error with a fabricated empty success');
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
