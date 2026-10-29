const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('stock workflow pages guard stale responses and initial duplicate refreshes', () => {
  const pages = ['src/components/BusinessForms/Receipt/index.tsx', 'src/components/BusinessForms/Transactions/index.tsx'];
  for (const file of pages) {
    const source = read(file);
    assert.match(source, /useRef\(0\)/, `${file} should keep a request sequence ref`);
    assert.match(source, /loadSequence|requestId|sequence/, `${file} should identify each load`);
    assert.match(source, /!== (?:loadSequence|requestId|sequence)\.current/, `${file} should discard stale responses`);
  }
  // The order-based outbound page has a single initial loader; its races and
  // draft preservation are exercised by workflow-regressions-browser.cjs.
  for (const file of ['src/components/BusinessForms/Receipt/index.tsx']) {
    const source = read(file);
    assert.match(source, /useDidShow/, `${file} should refresh on page display`);
    assert.match(source, /loadedAt\.current/, `${file} should gate duplicate requests`);
  }
  const home = read('src/pages/home/index.tsx');
  const workbench = read('src/components/Workspace/workbench.tsx');
  const remoteHook = read('src/hooks/useRemoteData.ts');
  assert.match(home, /<Workbench embedded initial='home' \/>/);
  assert.match(workbench, /useWorkbenchData\(\)/);
  const sourceHook = read('src/pages/home/useWorkbenchData.ts');
  assert.match(sourceHook, /const current = \+\+sequence\.current/);
  assert.match(sourceHook, /current !== sequence\.current/);
  assert.match(remoteHook, /const current = \+\+sequence\.current/);
  assert.match(remoteHook, /current !== sequence\.current/);
  for (const file of ['src/components/BusinessForms/Transactions/index.tsx']) {
    const source = read(file);
    assert.match(source, /lastLoadAt/, `${file} should gate repeated refreshes`);
    assert.match(source, /startedAt - lastLoadAt\.current < 250/, `${file} should suppress same-tick reloads`);
  }
});

test('orders uses the real shared sequence guard rather than a comment-only contract', () => {
  const source = read('src/components/BusinessForms/Orders/index.tsx');
  const hook = read('src/hooks/useRemoteData.ts');
  assert.ok(source.includes('const loadOrders = useCallback(async () => {'));
  assert.ok(source.includes('useRemoteData(loadOrders,'));
  assert.ok(hook.includes('const sequence = useRef(0)'));
  assert.ok(hook.includes('const current = ++sequence.current'));
  assert.ok(hook.includes('if (!mounted.current || current !== sequence.current) return;'));
  assert.ok(!source.includes('useEffect(() => { load(); }, [load])'), 'the hook already owns initial loading');
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
