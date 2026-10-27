const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { setImmediate: nextTurn } = require('node:timers/promises');

async function harness(options = {}) {
  const messages = [], calls = [], requests = [], frames = new Map(), records = [];
  let route = options.route || '/pages/home/index', frameId = 0, modal = false, mutation, observerOptions, observed = false, syncCount = 0;
  let depth = options.depth ?? 1;
  const backCalls = [];
  class HTMLElement {
    constructor(id, classes = [], inBody = true) {
      this.id = id;
      this.inBody = inBody;
      this.removals = 0;
      this.dataset = {};
      this.attributes = new Set();
      const tokens = new Set(classes);
      const changed = () => {
        if (observed && inBody && observerOptions.attributes && observerOptions.attributeFilter.includes('class')) {
          records.push({ type: 'attributes', attributeName: 'class', target: this });
        }
      };
      this.classList = {
        contains: token => tokens.has(token),
        add: token => { if (!tokens.has(token)) { tokens.add(token); changed(); } },
        remove: token => { if (tokens.delete(token)) { this.removals++; changed(); } },
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
    querySelector(selector) {
      return selector === '[data-tab-route]' && this.tabRoute ? { dataset: { tabRoute: this.tabRoute } } : null;
    }
    setAttribute(name) { this.attributes.add(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    toggleAttribute(name, force) {
      const next = force ?? !this.attributes.has(name);
      if (next) this.attributes.add(name); else this.attributes.delete(name);
      return next;
    }
    getAttribute(name) { return name === 'data-tab-route' && this.tabRoute ? this.tabRoute : null; }
  }
  const root = new HTMLElement('root', [], false), body = new HTMLElement('body');
  const dock = new HTMLElement('test-dock', ['sg-glass-dock']);
  const pages = {
    home: new HTMLElement('/pages/home/index', ['taro_page']),
    mine: new HTMLElement('/pages/mine/index', ['taro_page', 'taro_page_shade']),
    business: new HTMLElement('/pages/business-center/index', ['taro_page', 'taro_page_shade'])
  };
  pages.business.tabRoute = '/pages/home/index';
  const window = new EventTarget();
  window.closest = () => null;
  window.innerWidth = 390;
  window.matchMedia = query => ({ matches: query.includes('prefers-reduced-motion') ? Boolean(options.reduced) : false });
  window.__sgNativeDock = { api: 2, bottomSpace: 72 };
  window.webkit = { messageHandlers: { nativeTabSelected: { postMessage: s => messages.push(s) } } };
  const document = {
    documentElement: root, body,
    querySelector: selector => selector === 'taro-tabbar' ? dock : null,
    querySelectorAll: selector => selector === '.taro_page' ? Object.values(pages) : modal ? [new HTMLElement('modal')] : []
  };
  const exports = {};
  const context = vm.createContext({
    window, document, HTMLElement, navigator: { userAgent: 'test' }, innerWidth: 390, exports,
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
    route: () => route, depth: () => depth,
    back: async () => { backCalls.push('/pages/previous/index'); route = '/pages/home/index'; },
    switchTab: url => {
      calls.push(url);
      return new Promise((resolve, reject) => requests.push({
        resolve: () => { route = url; resolve(); }, reject
      }));
    },
    navigateTo: async url => { calls.push(url); route = url; }
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
  function setRoute(next) {
    route = next;
    Object.values(pages).forEach(page => {
      if (page.id === next) page.classList.remove('taro_page_shade');
      else page.classList.add('taro_page_shade');
    });
  }
  setRoute(route);
  async function touch(type, x, y, touchOptions = {}) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const point = { clientX: x, clientY: y };
    const touches = touchOptions.touches ?? (type === 'touchend' ? [] : [point]);
    const changedTouches = touchOptions.changedTouches ?? (type === 'touchend' ? [point] : [point]);
    Object.defineProperties(event, {
      touches: { value: touches }, changedTouches: { value: changedTouches }
    });
    window.dispatchEvent(event);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const notify = (mutations = [{ type: 'childList', target: body }]) => mutation(mutations);
  await flush();
  messages.length = 0;
  return {
    messages, calls, requests, backCalls, dispose, select, flush, pages, dock, setRoute, touch,
    observerOptions: () => observerOptions,
    syncCount: () => syncCount,
    pending: () => records.length + frames.size,
    element: id => new HTMLElement(id),
    mutation: notify,
    modal: value => { modal = value; notify(); },
    setRoute: value => { setRoute(value); notify(); },
    setDepth: value => { depth = value; },
    nativeReady: () => window.dispatchEvent(new Event('sg-native-ready')),
    tabContext: () => root.hasAttribute('data-tab-context')
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

test('business-center claims home for dock state and acknowledgments but still leaves for home', async () => {
  const h = await harness();
  try {
    h.setRoute('/pages/business-center/index');
    await h.flush();
    h.nativeReady();
    await h.flush();
    assert.equal(h.messages.at(-1).route, '/pages/home/index');
    assert.equal(h.tabContext(), true);

    h.select('home', 11);
    await h.flush();
    assert.deepEqual(h.calls, ['/pages/home/index'], 'the real home route is not treated as the current alias');
    h.requests[0].resolve();
    await h.flush();
    assert.equal(h.messages.at(-1).route, '/pages/home/index');
    assert.equal(h.tabContext(), false);
  } finally { h.dispose(); }
});

test('business-center starts page swipes at the home dock position', async () => {
  const h = await harness({ route: '/pages/business-center/index', depth: 2, reduced: true });
  try {
    await h.touch('touchstart', 200, 160);
    await h.touch('touchmove', 80, 160);
    await h.touch('touchend', 80, 160);
    await h.flush();
    assert.deepEqual(h.calls, ['/pages/ai-assistant/index']);
    h.requests[0].resolve();
    await h.flush();
    assert.equal(h.messages.at(-1).route, '/pages/ai-assistant/index');
  } finally { h.dispose(); }
});

test('business-center swipes right to the real home route', async () => {
  const h = await harness({ route: '/pages/business-center/index', depth: 2, reduced: true });
  try {
    await h.touch('touchstart', 120, 160);
    await h.touch('touchmove', 220, 160);
    await h.touch('touchend', 220, 160);
    await h.flush();
    assert.deepEqual(h.calls, ['/pages/home/index']);
    h.requests[0].resolve();
    await h.flush();
    h.nativeReady();
    await h.flush();
    assert.equal(h.messages.at(-1).route, '/pages/home/index');
  } finally { h.dispose(); }
});

test('iOS edge-back uses the real alias route instead of the claimed home tab', async () => {
  const h = await harness({ route: '/pages/business-center/index', depth: 2, reduced: true });
  try {
    await h.touch('touchstart', 20, 160);
    await h.touch('touchmove', 150, 160);
    await h.touch('touchend', 150, 160);
    await h.flush();
    assert.deepEqual(h.backCalls, ['/pages/previous/index']);
    assert.deepEqual(h.calls, []);
    h.nativeReady();
    await h.flush();
    assert.equal(h.messages.at(-1).route, '/pages/home/index');
  } finally { h.dispose(); }
});

test('ending a page swipe with another finger still down cancels the selection', async () => {
  const h = await harness({ route: '/pages/business-center/index', depth: 2, reduced: true });
  try {
    await h.touch('touchstart', 200, 160);
    await h.touch('touchmove', 80, 160);
    await h.touch('touchend', 80, 160, {
      touches: [{ clientX: 300, clientY: 220 }],
      changedTouches: [{ clientX: 80, clientY: 160 }]
    });
    await h.flush();
    assert.deepEqual(h.calls, []);
    h.nativeReady();
    await h.flush();
    assert.equal(h.messages.at(-1).route, '/pages/home/index');
  } finally { h.dispose(); }
});
