const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { setImmediate: nextTurn } = require('node:timers/promises');

async function harness() {
  const messages = [], calls = [], requests = [], frames = new Map(), records = [];
  let route = '/pages/home/index', frameId = 0, modal = false, mutation, observerOptions, observed = false, syncCount = 0;
  class HTMLElement {
    constructor(id, classes = [], inBody = true) {
      this.id = id;
      this.inBody = inBody;
      this.removals = 0;
      const tokens = new Set(classes);
      const changed = () => {
        if (observed && inBody && observerOptions.attributes && observerOptions.attributeFilter.includes('class')) {
          records.push({ type: 'attributes', attributeName: 'class', target: this });
        }
      };
      this.classList = {
        contains: token => tokens.has(token),
        add: token => { tokens.add(token); changed(); },
        remove: token => { this.removals++; tokens.delete(token); changed(); },
        toggle: (token, force) => {
          const present = tokens.has(token), next = force ?? !present;
          if (next === present) return next;
          if (next) tokens.add(token); else tokens.delete(token);
          changed();
          return next;
        }
      };
      this.style = { setProperty() {}, removeProperty() {} };
    }
    getBoundingClientRect() { return { width: 390, height: 100 }; }
  }
  const root = new HTMLElement('root', [], false), body = new HTMLElement('body');
  const dock = new HTMLElement('test-dock', ['sg-glass-dock']);
  const pages = {
    home: new HTMLElement('/pages/home/index', ['taro_page']),
    mine: new HTMLElement('/pages/mine/index', ['taro_page', 'taro_page_shade'])
  };
  const window = new EventTarget();
  window.matchMedia = () => ({ matches: false });
  window.__sgNativeDock = { api: 2, bottomSpace: 72 };
  window.webkit = { messageHandlers: { nativeTabSelected: { postMessage: s => messages.push(s) } } };
  const document = {
    documentElement: root, body,
    querySelector: selector => selector === 'taro-tabbar' ? dock : null,
    querySelectorAll: selector => selector === '.taro_page' ? Object.values(pages) : modal ? [new HTMLElement('modal')] : []
  };
  const exports = {};
  const context = vm.createContext({
    window, document, HTMLElement, navigator: { userAgent: 'test' }, exports,
    require: () => ({ createGlassTabBar: host => ({ host, update() { syncCount++; return this; }, preview() { return this; }, destroy() {} }) }),
    console: { error() {} }, setTimeout, clearTimeout,
    getComputedStyle: element => ({ display: element.classList.contains('taro_page_shade') ? 'none' : 'block' }),
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe(target, options) {
        assert.equal(target, body);
        observerOptions = options;
        observed = true;
      }
      disconnect() { observed = false; records.length = 0; }
    }
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
    for (let pass = 0; records.length || frames.size; pass++) {
      assert.ok(pass < 10, 'page-class observer must settle without an animation-frame loop');
      if (records.length) mutation(records.splice(0));
      const scheduled = [...frames.values()]; frames.clear();
      scheduled.forEach(callback => callback(0));
      await nextTurn();
    }
  }
  const notify = (mutations = [{ type: 'childList', target: body }]) => mutation(mutations);
  await flush();
  messages.length = 0;
  return {
    messages, calls, requests, dispose, select, flush, pages, dock,
    observerOptions: () => observerOptions,
    syncCount: () => syncCount,
    pending: () => records.length + frames.size,
    element: id => new HTMLElement(id),
    mutation: notify,
    modal: value => { modal = value; notify(); }
  };
}

test('rapid native changes keep the final destination and suppress stale route acknowledgments', async () => {
  const h = await harness();
  try {
    h.select('ai-assistant', 1); h.select('inventory', 2); h.select('mine', 3);
    await h.flush();
    assert.equal(h.messages.length, 0, 'old route cannot reset native selection while pending');
    assert.deepEqual(h.calls, ['/pages/ai-assistant/index']);
    h.requests[0].resolve(); await h.flush();
    assert.deepEqual(h.calls, ['/pages/ai-assistant/index', '/pages/mine/index']);
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
  const h = await harness();
  try {
    h.select('ai-assistant', 7); h.requests[0].reject(new Error('route failed')); await h.flush();
    assert.equal(h.messages[0].route, '/pages/home/index');
    assert.equal(h.messages[0].requestId, 7);
    assert.equal(h.messages[0].navigationFailed, true);
    h.select('inventory', 8); h.requests[1].resolve(); await h.flush();
    assert.equal(h.messages.at(-1).route, '/pages/inventory/index');
    assert.equal(h.messages.at(-1).navigationFailed, false);
  } finally { h.dispose(); }
});

test('native requests cannot switch behind a modal and same-tab selections still acknowledge', async () => {
  const h = await harness();
  try {
    h.modal(true); h.select('ai-assistant', 9); await h.flush();
    assert.equal(h.calls.length, 0);
    assert.equal(h.messages.at(-1).navigationFailed, true);
    assert.equal(h.messages.at(-1).modal, true);
    h.modal(false); h.select('home', 10); await h.flush();
    assert.equal(h.calls.length, 0);
    assert.equal(h.messages.at(-1).requestId, 10);
    assert.equal(h.messages.at(-1).navigationFailed, false);
  } finally { h.dispose(); }
});

test('page observer watches class changes as well as child-list transitions', async () => {
  const h = await harness();
  try {
    const options = h.observerOptions();
    assert.equal(options.childList, true);
    assert.equal(options.subtree, true);
    assert.equal(options.attributes, true);
    assert.deepEqual(Array.from(options.attributeFilter), ['class']);
  } finally { h.dispose(); }
});

test('a delayed Taro hide timer reveals the active tab without clearing inactive pages or looping', async () => {
  const h = await harness();
  try {
    const active = h.pages.home, inactive = h.pages.mine;
    const syncs = h.syncCount();
    active.classList.add('taro_page_shade');
    assert.equal(active.classList.contains('taro_page_shade'), true, 'late hide timer hides the already acknowledged tab');
    await h.flush();
    assert.equal(active.classList.contains('taro_page_shade'), false, 'class mutation reveals the active tab without a route event');
    assert.equal(inactive.classList.contains('taro_page_shade'), true, 'inactive tab stays hidden');
    assert.equal(active.removals, 1, 'only the present shade token is removed');
    assert.equal(inactive.removals, 0);
    assert.equal(h.syncCount() - syncs, 2, 'shade removal receives one observer notification, then settles');
    assert.equal(h.pending(), 0);
    assert.equal(h.messages.length, 0, 'restoring page visibility does not duplicate the native acknowledgment');
    await h.flush();
    assert.equal(h.syncCount() - syncs, 2, 'an idle page cannot reschedule itself indefinitely');
  } finally { h.dispose(); }
});

test('non-page and animated dock class changes do not schedule navigation sync', async () => {
  const h = await harness();
  try {
    const syncs = h.syncCount();
    h.dock.classList.add('sg-glass-dock-moving');
    h.element('unrelated-control').classList.add('focused');
    await h.flush();
    assert.equal(h.syncCount(), syncs);
    assert.equal(h.pending(), 0);
    assert.equal(h.messages.length, 0);
    h.mutation();
    await h.flush();
    assert.equal(h.syncCount(), syncs + 1, 'child-list changes still synchronize dock and modal state');
  } finally { h.dispose(); }
});
