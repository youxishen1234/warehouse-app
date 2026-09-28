const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('products page keeps loading, error and empty states distinct', () => {
  const source = fs.readFileSync('src/pages/products/index.tsx', 'utf8');
  assert.match(source, /import \{ useRemoteData \} from '\@\/hooks\/useRemoteData'/);
  assert.match(source, /const remote = useRemoteData\(loadProductData/);
  assert.match(source, /const loading = remote\.loading/);
  assert.match(source, /const loadError = remote\.loadError/);
  assert.match(fs.readFileSync('src/hooks/useRemoteData.ts', 'utf8'), /sequence = useRef\(0\)/);
  assert.match(fs.readFileSync('src/hooks/useRemoteData.ts', 'utf8'), /current !== sequence\.current/);
  assert.match(fs.readFileSync('src/hooks/useRemoteData.ts', 'utf8'), /mounted = useRef\(true\)/);
  assert.match(fs.readFileSync('src/hooks/useRemoteData.ts', 'utf8'), /!mounted\.current/);
  assert.match(source, /\{loading \? \(/);
  assert.match(source, /\) : loadError \? \(/);
  assert.match(source, /onClick=\{load\}/);
  assert.match(source, /\) : list\.length === 0 \? \(/);
});

test('remote loader invalidates stale requests on unmount', () => {
  const source = fs.readFileSync('src/hooks/useRemoteData.ts', 'utf8');
  assert.match(source, /mounted\.current = false/);
  assert.match(source, /sequence\.current \+= 1/);
});
