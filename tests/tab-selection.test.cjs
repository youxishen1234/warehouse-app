const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { setImmediate: nextTurn } = require('node:timers/promises');

function harness() {
  const messages = [], calls = [], requests = [], frames = new Map();
  let route = '/pages/home/index', frameId = 0, modal = false, mutation;
  const window = new EventTarget();
  window.matchMedia = () => ({ matches: false });
  window.__sgNativeDock = { api: 2, bottomSpace: 72 };
  window.webkit = { messageHandlers: { nativeTabSelected: { postMessage: s => messages.push(s) } } };
  const document = {
    documentElement: { classList: { toggle() {} }, style: { setProperty() {} } }, body: {},
    querySelector: () => null,
    querySelectorAll: selector => selector === '.taro_page' || !modal ? [] : [{ getBoundingClientRect: () => ({ height: 100 }) }]
  };
  const exports = {};
  const context = vm.createContext({
    window, document, navigator: { userAgent: 'test' }, exports,
    require: () => ({ createGlassTabBar: () => { throw new Error('no dock mounted in this unit test'); } }),
    console: { error() {} }, setTimeout, clearTimeout,
    getComputedStyle: () => ({ display: 'block' }),
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} }
  });
  const source = ts.transpileModule(fs.readFileSync('src/services/tab-navigation.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(source, context);
  const dispose = exports.installTabNavigation({
    route: () => route, depth: () => 1, back: async () => {},
    switchTab: url => {
      calls.push(url);
      return new Promise((resolve, reject) => requests.push({
        resolve: () => { route = url; resolve(); }, reject
      }));
    }
  });
  function select(name, requestId) {
    const event = new CustomEvent('sg-native-tab', { detail: '/pages/' + name + '/index' });
    event.requestId = requestId; window.dispatchEvent(event);
  }
  async function flush() {
    await nextTurn();
    const scheduled = [...frames.values()]; frames.clear();
    scheduled.forEach(callback => callback(0));
    await nextTurn();
  }
  messages.length = 0;
  return { messages, calls, requests, dispose, select, flush, mutation: () => mutation(), modal: value => { modal = value; mutation(); } };
}

test('rapid native changes keep the final destination and suppress stale route acknowledgments', async () => {
  const h = harness();
  try {
    h.select('board-stock', 1); h.select('outbound', 2); h.select('mine', 3);
    h.mutation(); await h.flush();
    assert.equal(h.messages.length, 0, 'old route cannot reset native selection while pending');
    assert.deepEqual(h.calls, ['/pages/board-stock/index']);
    h.requests[0].resolve(); await h.flush();
    assert.deepEqual(h.calls, ['/pages/board-stock/index', '/pages/mine/index']);
    assert.equal(h.messages.length, 0);
    h.requests[1].resolve(); await h.flush();
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].requestId, 3);
    assert.equal(h.messages[0].route, '/pages/mine/index');
    assert.equal(h.messages[0].navigationFailed, false);
    h.mutation(); await h.flush();
    assert.equal(h.messages.length, 1, 'stable selection is not repeatedly written back to UIKit');
  } finally { h.dispose(); }
});

test('failed navigation acknowledges the actual route and allows the next selection', async () => {
  const h = harness();
  try {
    h.select('board-stock', 7); h.requests[0].reject(new Error('route failed')); await h.flush();
    assert.equal(h.messages[0].route, '/pages/home/index');
    assert.equal(h.messages[0].requestId, 7);
    assert.equal(h.messages[0].navigationFailed, true);
    h.select('outbound', 8); h.requests[1].resolve(); await h.flush();
    assert.equal(h.messages.at(-1).route, '/pages/outbound/index');
    assert.equal(h.messages.at(-1).navigationFailed, false);
  } finally { h.dispose(); }
});

test('native requests cannot switch behind a modal and same-tab selections still acknowledge', async () => {
  const h = harness();
  try {
    h.modal(true); h.select('board-stock', 9); await h.flush();
    assert.equal(h.calls.length, 0);
    assert.equal(h.messages.at(-1).navigationFailed, true);
    assert.equal(h.messages.at(-1).modal, true);
    h.modal(false); h.select('home', 10); await h.flush();
    assert.equal(h.calls.length, 0);
    assert.equal(h.messages.at(-1).requestId, 10);
    assert.equal(h.messages.at(-1).navigationFailed, false);
  } finally { h.dispose(); }
});
