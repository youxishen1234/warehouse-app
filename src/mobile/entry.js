/* A real narrow viewport keeps CSS breakpoints, dialogs and navigation on the
   phone layout even when this shareable entry is opened on a wide screen. */
(function () {
  const frame = document.getElementById('mobile-app');
  const home = '#/pages/home/index';
  const route = value => value.startsWith('#/pages/') && value.includes('/index') && !value.includes('//') ? value : home;
  frame.src = '/embed/' + route(location.hash);
  const synchronize = () => {
    try {
      const hash = route(frame.contentWindow.location.hash);
      if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
    } catch { /* Wait for the same-origin application to finish loading. */ }
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
