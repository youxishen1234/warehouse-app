/* global React, ReactDOM, modules, styles, pageEntry */
const taro = {
  getStorageSync: key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  setStorageSync: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
  removeStorageSync: key => localStorage.removeItem(key),
  getStorageInfoSync: () => ({ keys: Object.keys(localStorage) }),
  showToast: () => {},
  getCurrentPages: () => [{ route: 'pages/print-center/index' }],
  navigateBack: async () => {},
  switchTab: async () => {},
};
const bluetoothFixture = window.__PRINT_BLUETOOTH_SOURCE_PREVIEW__ === true;
function createBluetoothFixture() {
  const activeKey = 'warehouse_bluetooth_630k_active_job_v1';
  const printer = { deviceId: '630k-device-1', relayId: 'relay-630k-1', name: '630K 测试打印电脑' };
  const state = { connected: true, printer, error: '', job: undefined };
  const listeners = new Set();
  let nextQueryStatus = 'processing';
  let serial = 0;
  let activeQueries = 0;
  let holdQueries = false;
  const heldQueries = new Set();
  const test = {
    sendCalls: [], queryCalls: [], maxActiveQueries: 0, failNextRemoteRead: false,
    setNextQueryStatus: status => { nextQueryStatus = status; },
    holdQueries: () => { holdQueries = true; },
    releaseQueries: () => { holdQueries = false; heldQueries.forEach(resolve => resolve()); heldQueries.clear(); },
  };
  const snapshot = () => ({ ...state, printer: { ...printer }, ...(state.job ? { job: { ...state.job } } : {}) });
  const publish = () => listeners.forEach(listener => { try { listener(snapshot()); } catch {} });
  const readPending = () => taro.getStorageSync(activeKey) || undefined;
  const jobFor = (id, status) => ({ v: 1, id, status, message: status === 'queued' ? '已进入 Windows 队列' : '测试任务处理中', updatedAt: Date.now() });
  const service = {
    isBluetooth630KSupported: () => true,
    getBluetooth630KState: snapshot,
    readBluetooth630KPrinter: () => ({ ...printer }),
    readBluetooth630KPending: strict => { const value = readPending(); if (strict && value && typeof value.id !== 'string') throw new Error('pending 记录异常'); return value; },
    watchBluetooth630K: listener => { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    connectBluetooth630K: async () => { state.connected = true; state.error = ''; publish(); return { ...printer }; },
    sendBluetooth630KJob: async input => {
      test.sendCalls.push({ id: input.id, note: input.document?.number });
      const job = jobFor(input.id, 'received');
      taro.setStorageSync(activeKey, { id: input.id, deviceId: printer.deviceId, relayId: printer.relayId });
      state.job = job; publish(); return job;
    },
    queryBluetooth630KJob: async id => {
      if (!state.connected) throw new Error('打印电脑已断开');
      test.queryCalls.push(id); activeQueries++; test.maxActiveQueries = Math.max(test.maxActiveQueries, activeQueries);
      try {
        if (holdQueries) await new Promise(resolve => heldQueries.add(resolve));
        else await new Promise(resolve => setTimeout(resolve, 180));
        if (!state.connected) throw new Error('打印电脑已断开');
        const status = nextQueryStatus;
        nextQueryStatus = 'processing';
        const job = jobFor(id, status); state.job = job;
        if (status === 'queued' || status === 'printed' || status === 'failed') taro.removeStorageSync(activeKey);
        publish(); return job;
      } finally { activeQueries--; }
    },
    resolveBluetooth630KJob: async id => { const job = jobFor(id, 'printed'); state.job = job; taro.removeStorageSync(activeKey); publish(); return job; },
  };
  test.getActiveQueries = () => activeQueries;
  test.getState = snapshot;
  test.disconnect = () => { state.connected = false; publish(); };
  test.reconnect = () => { state.connected = true; publish(); };
  window.__bluetooth630kTest = test;
  return {
    service,
    pending: {
      readBluetooth630KPending: strict => { const value = taro.getStorageSync(activeKey) || undefined; if (strict && value && typeof value.id !== 'string') throw new Error('pending 记录异常'); return value; },
      readRemotePrintPending: () => { if (test.failNextRemoteRead) { test.failNextRemoteRead = false; throw new Error('测试存储读取异常'); } return undefined; },
    },
    remote: { newRemotePrintId: () => 'bluetooth-browser-test-' + String(++serial).padStart(12, '0') },
  };
}
const bluetooth = bluetoothFixture ? createBluetoothFixture() : undefined;
function useDidShow(callback) {
  const latest = React.useRef(callback);
  latest.current = callback;
  React.useEffect(() => { latest.current(); }, []);
}
const cache = {
  react: React,
  'react-dom': ReactDOM,
  '@tarojs/taro': { __esModule: true, default: taro, useRouter: () => ({ params: Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || '')) }), useDidShow },
  'react/jsx-runtime': { jsx: (type, props, key) => React.createElement(type, { ...props, key }), jsxs: (type, props, key) => React.createElement(type, { ...props, key }), Fragment: React.Fragment },
  '@/services/bluetooth-630k': bluetooth?.service,
  '@/services/print-transport-pending': bluetooth?.pending,
  '@/services/remote-print': bluetooth?.remote,
  style: styles,
};
function loadSource(id) {
  if (cache[id]) return cache[id];
  const module = { exports: {} };
  cache[id] = module.exports;
  const { source, deps } = modules[id];
  new Function('require', 'module', 'exports', source)(name => name === 'node:fs' ? null : loadSource(deps[name]), module, module.exports);
  cache[id] = module.exports;
  return module.exports;
}
taro.setStorageSync('warehouse_session_v1', { token: 'isolated-source-preview', user: { id: 'preview', username: 'preview', role: 'operator' } });
if (bluetoothFixture) {
  const BluetoothPrint = loadSource(pageEntry).default;
  function BluetoothHarness() {
    const [bill, setBill] = React.useState(1);
    const saved = { id: bill, number: 'TEST-630K-' + bill, version: 1 };
    const document = { key: 'test-doc-' + bill, number: saved.number };
    return React.createElement(React.Fragment, null,
      React.createElement('button', { type: 'button', onClick: () => setBill(value => value === 1 ? 2 : 1) }, '切换测试单据'),
      React.createElement(BluetoothPrint, { enabled: true, ready: true, saved, document, settings: { paper: 'A4' }, autoSend: false })
    );
  }
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(BluetoothHarness));
} else ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(loadSource(pageEntry).default));
