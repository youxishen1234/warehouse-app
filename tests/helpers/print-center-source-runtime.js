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
const cache = {
  react: React,
  'react-dom': ReactDOM,
  '@tarojs/taro': { __esModule: true, default: taro, useRouter: () => ({ params: Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || '')) }) },
  'react/jsx-runtime': { jsx: (type, props, key) => React.createElement(type, { ...props, key }), jsxs: (type, props, key) => React.createElement(type, { ...props, key }), Fragment: React.Fragment },
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
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(loadSource(pageEntry).default));
