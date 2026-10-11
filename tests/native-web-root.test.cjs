const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function scripts() {
  const html = fs.readFileSync('src/index.html', 'utf8');
  return [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
}

function bootstrap({ protocol = 'http:', native = false, hash = '' } = {}) {
  const inline = scripts();
  const navigation = inline.find(script => script.includes('document.write(') && script.includes('base href'));
  const auxiliary = inline.find(script => script.includes('home-search.js'));
  const writes = [];
  const window = {
    location: { protocol, pathname: '/', hash, search: '', href: protocol + '//localhost/' },
    history: { replaceState: () => {} },
    Capacitor: { isNativePlatform: () => native },
    addEventListener: () => {}
  };
  const document = {
    write: value => writes.push(value),
    getElementById: () => null,
    createElement: () => ({ style: {}, remove: () => {} }),
    body: { appendChild: () => {} }
  };
  vm.runInNewContext(navigation, { window, document, URL });
  vm.runInNewContext(auxiliary, { window, document });
  return { writes, window };
}

test('Android Capacitor bundles resolve app and auxiliary assets relative to the active update', () => {
  const { writes } = bootstrap({ protocol: 'http:', native: true, hash: '#/pages/mine/index' });
  assert(writes.includes('<base href="./">'));
  assert(writes.some(value => value.includes('./js/home-search.js')));
  assert(writes.some(value => value.includes('./css/polish.css')));
});

test('iOS and Electron retain relative assets while ordinary web remains root-based', () => {
  const ios = bootstrap({ protocol: 'capacitor:', native: true });
  assert(ios.writes.includes('<base href="./">'));
  assert(ios.writes.some(value => value.includes('./js/home-search.js')));
  const desktop = bootstrap({ protocol: 'file:' });
  assert(desktop.writes.includes('<base href="./">'));
  assert(desktop.writes.some(value => value.includes('./js/home-search.js')));
  const web = bootstrap({ protocol: 'https:', hash: '#/pages/home/index' });
  assert(web.writes.includes('<base href="/">'));
  assert(web.writes.some(value => value.includes('/js/home-search.js')));
});

test('native root detection stays safe when the Capacitor bridge is unavailable', () => {
  for (const capacitor of [undefined]) {
    const inline = scripts();
    const navigation = inline.find(script => script.includes('document.write(') && script.includes('base href'));
    const auxiliary = inline.find(script => script.includes('home-search.js'));
    const writes = [];
    const window = { location: { protocol: 'http:', hostname: 'localhost', pathname: '/', hash: '', search: '', href: 'http://localhost/' }, Capacitor: capacitor, history: { replaceState: () => {} }, addEventListener: () => {} };
    const document = { write: value => writes.push(value), getElementById: () => null, createElement: () => ({ style: {}, remove: () => {} }), body: { appendChild: () => {} } };
    vm.runInNewContext(navigation, { window, document, URL });
    vm.runInNewContext(auxiliary, { window, document });
    assert(writes.includes('<base href="./">'));
    assert(writes.some(value => value.includes('./js/home-search.js')));
  }
});
