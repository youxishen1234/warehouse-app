(function () {
  const frame = document.getElementById('mobile-app');
  const home = '#/pages/home/index';
  const routes = new Set([
    '#/pages/home/index',
    '#/pages/customers/index',
    '#/pages/inventory/index',
    '#/pages/finance/index',
    '#/pages/suppliers/index',
    '#/pages/print-center/index'
  ]);
  const route = value => routes.has(value) ? value : home;
  frame.src = '/embed/' + route(location.hash);
  const synchronize = () => {
    try {
      const hash = route(frame.contentWindow.location.hash);
      if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
  } catch {}
  };
  frame.addEventListener('load', () => {
    frame.contentWindow.addEventListener('hashchange', synchronize);
    frame.contentWindow.addEventListener('popstate', synchronize);
    synchronize();
  });
  // Taro also navigates with history.pushState, which emits no hashchange.
  const timer = window.setInterval(synchronize, 250);
  window.addEventListener('pagehide', () => window.clearInterval(timer));
  window.addEventListener('hashchange', () => {
    const hash = route(location.hash);
    if (frame.contentWindow.location.hash !== hash) frame.contentWindow.location.hash = hash;
  });
})();
