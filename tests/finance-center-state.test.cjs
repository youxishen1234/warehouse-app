'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const React = require('react');
const ReactDOM = require('react-dom/client');
const { act } = require('react-dom/test-utils');
const ts = require('typescript');
const { JSDOM } = require('jsdom');

const sourcePath = path.resolve(__dirname, '../src/components/FinanceCenter/index.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    jsx: ts.JsxEmit.React,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020
  }
}).outputText;

const createEntry = (id, attachments = []) => ({
  id,
  type: 'income',
  amount: 10,
  remark: `Entry ${id}`,
  created_at: Date.now(),
  attachments
});

function createHarness({ entryId, ledger, getLedger = async () => [] }) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const previous = {};
  for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
    previous[key] = Object.getOwnPropertyDescriptor(global, key);
  }
  Object.defineProperty(global, 'window', { configurable: true, writable: true, value: dom.window });
  Object.defineProperty(global, 'document', { configurable: true, writable: true, value: dom.window.document });
  Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: dom.window.navigator });
  Object.defineProperty(global, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

  const attachments = ({ entry, onSaved }) => React.createElement('div', null,
    React.createElement('span', { 'data-testid': 'attachment-count' }, String(entry.attachments?.length || 0)),
    React.createElement('button', {
      'data-testid': 'mock-upload-success',
      onClick: () => onSaved(entry.id, { id: 42, url: '/proof.jpg', name: 'proof.jpg' })
    }, '上传成功'));
  const button = props => React.createElement('button', props, props.children);
  const noop = async () => {};
  const modules = {
    '@tarojs/components': { View: 'div', Text: 'span', Input: 'input', Picker: 'div' },
    '@tarojs/taro': { __esModule: true, default: { showToast: noop, showModal: async () => ({ confirm: true }) } },
    '@/components/Icon': { __esModule: true, default: () => null },
    '@/services/api': { addLedger: noop, deleteLedger: noop, getLedger, settleCustomer: noop, settleSupplier: noop },
    '@/utils/format': { formatMoney: value => Number(value || 0).toFixed(2), formatTime: () => '2026-10-24 10:00' },
    '@/services/download': { downloadCsv: noop },
    '@/utils/form-input': { parseMoneyInput: value => Number(value), previewMoneyInput: value => Number(value), sanitizeNonNegativeMoneyInput: value => value },
    '@/pages/ledger/model': {
      amountPrefix: () => '', dateBounds: () => ({}), dateKey: () => '2026-10-24',
      filterLedger: rows => rows, groupLedger: rows => rows.length ? [{ date: '2026-10-24', entries: rows }] : [],
      isLinkedEntry: () => false, ledgerTypes: [{ value: '', label: '全部' }, { value: 'income', label: '收入' }],
      monthRange: () => ({ from: '', to: '' }), summarizeLedger: () => ({ net: 0, income: 0, expense: 0, receivable: 0, payable: 0, settlement: 0 })
    },
    '@/pages/ledger/attachments': { __esModule: true, default: attachments },
    '@/pages/ledger/button': { __esModule: true, default: button },
    './model': {
      filterPartyLedgerEntries: () => [], inferredPartyType: () => '', partyPeriodLabel: () => '',
      summarizePartyLedger: () => ({ sales: 0, settled: 0 }), summarizeProductionInbound: () => ({ total: 0, count: 0, notes: [] })
    },
    './index.module.scss': { __esModule: true, default: new Proxy({}, { get: (_target, key) => String(key) }) }
  };
  const localRequire = id => Object.prototype.hasOwnProperty.call(modules, id) ? modules[id] : require(id);
  const componentModule = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(localRequire, componentModule, componentModule.exports);
  const FinanceCenter = componentModule.exports.default;
  const container = dom.window.document.getElementById('root');
  const root = ReactDOM.createRoot(container);
  const props = {
    entryId, ledger, customers: [], suppliers: [], deliveryNotes: [], loading: false, loadError: '', onReload: noop
  };
  const render = async next => act(async () => { root.render(React.createElement(FinanceCenter, { ...props, ...next })); });
  const click = async selector => {
    const element = container.querySelector(selector);
    assert.ok(element, `expected element ${selector}`);
    await act(async () => element.click());
  };
  const cleanup = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(global, key, descriptor);
      else delete global[key];
    }
  };
  return { cleanup, click, container, render };
}

test('FinanceCenter preserves uploaded proof across refreshes and reconciles it without duplicates', async () => {
  const view = createHarness({ entryId: undefined, ledger: [createEntry(7)] });
  try {
    await view.render();
    await view.click('[data-testid="ledger-entry-7"]');
    await view.click('[data-testid="mock-upload-success"]');
    assert.equal(view.container.querySelector('[data-testid="attachment-count"]').textContent, '1');

    await view.render({ ledger: [createEntry(7)] });
    assert.equal(view.container.querySelector('[data-testid="attachment-count"]').textContent, '1', 'background refresh must retain the confirmed upload');

    await view.render({ ledger: [createEntry(7, [{ id: 42, url: '/proof.jpg', name: 'proof.jpg' }])] });
    assert.equal(view.container.querySelector('[data-testid="attachment-count"]').textContent, '1', 'server copy should replace the pending local copy');
    await view.render({ ledger: [createEntry(7, [{ id: 42, url: '/proof.jpg', name: 'proof.jpg' }])] });
    assert.equal(view.container.querySelector('[data-testid="attachment-count"]').textContent, '1', 'repeated refreshes must not duplicate attachments');
  } finally {
    await view.cleanup();
  }
});

test('closing an entry deep link keeps it closed through refreshes', async () => {
  const view = createHarness({ entryId: 11, ledger: [createEntry(11)] });
  try {
    await view.render();
    assert.ok(view.container.querySelector('[role="dialog"][aria-label="流水详情"]'));
    await view.click('[aria-label="关闭流水详情"]');
    assert.equal(view.container.querySelector('[role="dialog"][aria-label="流水详情"]'), null);
    await view.render({ ledger: [createEntry(11)] });
    assert.equal(view.container.querySelector('[role="dialog"][aria-label="流水详情"]'), null, 'refresh must not reopen the consumed entry link');
  } finally {
    await view.cleanup();
  }
});

test('a late deep-link lookup cannot replace a newer manually selected ledger entry', async () => {
  let resolveLookup;
  const lookup = new Promise(resolve => { resolveLookup = resolve; });
  const view = createHarness({ entryId: 21, ledger: [createEntry(22)], getLedger: () => lookup });
  try {
    await view.render();
    await view.click('[data-testid="ledger-entry-22"]');
    assert.match(view.container.textContent, /LS-000022/);
    await act(async () => {
      resolveLookup([createEntry(21)]);
      await lookup;
    });
    assert.match(view.container.textContent, /LS-000022/, 'the late lookup must not replace the user\'s current selection');
    assert.doesNotMatch(view.container.textContent, /LS-000021/);
  } finally {
    await view.cleanup();
  }
});

test('a changed entry deep link wins over an earlier unresolved request', async () => {
  const pending = new Map();
  const view = createHarness({ entryId: 31, ledger: [], getLedger: ({ id }) => new Promise(resolve => pending.set(id, resolve)) });
  try {
    await view.render();
    await view.render({ entryId: 32 });
    await act(async () => pending.get(32)([createEntry(32)]));
    assert.match(view.container.textContent, /LS-000032/);
    await act(async () => pending.get(31)([createEntry(31)]));
    assert.match(view.container.textContent, /LS-000032/);
    assert.doesNotMatch(view.container.textContent, /LS-000031/);
  } finally {
    await view.cleanup();
  }
});

test('a late entry lookup is ignored after the finance view unmounts', async () => {
  let resolveLookup;
  const view = createHarness({ entryId: 41, ledger: [], getLedger: () => new Promise(resolve => { resolveLookup = resolve; }) });
  await view.render();
  await view.cleanup();
  await act(async () => resolveLookup([createEntry(41)]));
  assert.equal(view.container.querySelector('[role="dialog"]'), null);
});

test('background loading preserves the open detail and its confirmed proof', async () => {
  const view = createHarness({ entryId: 51, ledger: [createEntry(51)] });
  try {
    await view.render();
    await view.click('[data-testid="mock-upload-success"]');
    await view.render({ loading: true, ledger: [createEntry(51)] });
    assert.match(view.container.textContent, /LS-000051/);
    assert.equal(view.container.querySelector('[data-testid="attachment-count"]').textContent, '1');
    await view.render({ loading: false, ledger: [createEntry(51)] });
    assert.equal(view.container.querySelector('[data-testid="attachment-count"]').textContent, '1');
  } finally {
    await view.cleanup();
  }
});
