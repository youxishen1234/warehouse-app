export const tabRoutes = ['/pages/home/index', '/pages/inbound/index', '/pages/outbound/index', '/pages/mine/index'];

export function normalizeRoute(value: string): string {
  return '/' + value.replace(/^#?\/?/, '').split(/[?#]/)[0].replace(/\/$/, '');
}

type Navigation = {
  route: () => string;
  switchTab: (url: string) => Promise<unknown>;
  back: () => Promise<unknown>;
  depth: () => number;
};

// One gesture owner for browser, Android and iOS, independent of dock visibility.
export function installTabNavigation(nav: Navigation): () => void {
  const root = document.documentElement;
  const win = window as any;
  let busy = false;
  let frame = 0;
  let state: { x: number; y: number; dx: number; locked: boolean; index: number; page: HTMLElement; back: boolean } | null = null;
  let suppressClickUntil = 0;
  let disposed = false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const android = /Android/i.test(navigator.userAgent) || win.Capacitor?.getPlatform?.() === 'android';
  const route = () => normalizeRoute(nav.route());
  const activePage = () => Array.from(document.querySelectorAll<HTMLElement>('.taro_page')).reverse()
    .find(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0);
  const modalOpen = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], .sg-calc-overlay, .taro-modal, [class*="mask___"]'))
    .some(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0);

  const sync = () => {
    if (disposed) return;
    const capability = win.__sgNativeDock;
    const native = capability?.api === 2 && win.webkit?.messageHandlers?.nativeTabSelected;
    root.classList.toggle('sg-native-ios', !!native);
    if (native) {
      root.style.setProperty('--sg-native-bottom-space', String(capability.bottomSpace || 84) + 'px');
      native.postMessage({ route: route(), ready: true, modal: modalOpen() });
    }
  };
  const scheduleSync = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; sync(); });
  };
  const restore = (page: HTMLElement) => {
    page.style.removeProperty('transform');
    page.style.removeProperty('transition');
    page.style.removeProperty('will-change');
  };
  const animate = (page: HTMLElement, x: number) => new Promise<void>(resolve => {
    page.style.setProperty('transition', reduced ? 'none' : 'transform 160ms ease-out', 'important');
    page.style.setProperty('transform', 'translate3d(' + x + 'px,0,0)', 'important');
    setTimeout(resolve, reduced ? 0 : 165);
  });
  const switchTo = async (url: string) => {
    if (busy || !tabRoutes.includes(url) || url === route()) return;
    busy = true;
    try { await nav.switchTab(url); } catch (error) { console.error('[Navigation]', error); }
    finally { busy = false; scheduleSync(); }
  };
  const nativeSelect = (event: Event) => { void switchTo((event as CustomEvent<string>).detail); };
  const cancel = () => {
    const current = state;
    state = null;
    if (current) { restore(current.page); }
  };
  const start = (event: TouchEvent) => {
    if (busy || event.touches.length !== 1) { cancel(); return; }
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, button, a, [role="button"], taro-input-core, taro-picker-core, taro-textarea-core, .weui-tabbar, [class*="wrap___"], [data-no-tab-swipe]') || modalOpen()) return;
    const touch = event.touches[0];
    const index = tabRoutes.indexOf(route());
    const back = !android && index < 0 && nav.depth() > 1 && touch.clientX < 35;
    // Reserve both Android system-back edges. Tab gestures also stay central on iOS.
    if (!back && (touch.clientX < 50 || touch.clientX > innerWidth - 50)) return;
    const page = activePage();
    if (!page || (index < 0 && !back)) return;
    state = { x: touch.clientX, y: touch.clientY, dx: 0, locked: false, index, page, back };
  };
  const move = (event: TouchEvent) => {
    if (!state || event.touches.length !== 1) { cancel(); return; }
    const dx = event.touches[0].clientX - state.x;
    const dy = event.touches[0].clientY - state.y;
    if (!state.locked) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { cancel(); return; }
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
      if (state.back && dx < 0) { cancel(); return; }
      state.locked = true;
      state.page.style.setProperty('will-change', 'transform');
      state.page.style.setProperty('transition', 'none', 'important');
    }
    if (event.cancelable) event.preventDefault();
    state.dx = dx;
    const next = state.index + (dx < 0 ? 1 : -1);
    const amount = !state.back && (next < 0 || next >= tabRoutes.length) ? dx * .2 : dx;
    state.page.style.setProperty('transform', 'translate3d(' + amount + 'px,0,0)', 'important');
  };
  const end = async () => {
    const current = state;
    state = null;
    if (!current?.locked) return;
    suppressClickUntil = Date.now() + 350;
    const next = current.index + (current.dx < 0 ? 1 : -1);
    const commit = Math.abs(current.dx) >= 64 && (current.back || (next >= 0 && next < tabRoutes.length));
    busy = true;
    try {
      await animate(current.page, commit ? (current.dx < 0 ? -innerWidth : innerWidth) : 0);
      if (commit && !disposed) {
        await (current.back ? nav.back() : nav.switchTab(tabRoutes[next]));
      }
    } catch (error) { console.error('[Navigation]', error); }
    finally { restore(current.page); busy = false; scheduleSync(); }
  };
  const blockClick = (event: MouseEvent) => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  // Touch only: installing pointer and touch handlers together double-switches iOS tabs.
  window.addEventListener('touchstart', start, { passive: true, capture: true });
  window.addEventListener('touchmove', move, { passive: false, capture: true });
  window.addEventListener('touchend', end, { passive: true, capture: true });
  window.addEventListener('touchcancel', cancel, { passive: true, capture: true });
  window.addEventListener('click', blockClick, true);
  window.addEventListener('sg-native-tab', nativeSelect);
  window.addEventListener('sg-native-ready', scheduleSync);
  window.addEventListener('hashchange', scheduleSync);
  window.addEventListener('popstate', scheduleSync);
  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.body, { childList: true, subtree: true });
  sync();
  return () => {
    disposed = true;
    cancel();
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener('touchstart', start, true);
    window.removeEventListener('touchmove', move, true);
    window.removeEventListener('touchend', end, true);
    window.removeEventListener('touchcancel', cancel, true);
    window.removeEventListener('click', blockClick, true);
    window.removeEventListener('sg-native-tab', nativeSelect);
    window.removeEventListener('sg-native-ready', scheduleSync);
    window.removeEventListener('hashchange', scheduleSync);
    window.removeEventListener('popstate', scheduleSync);
  };
}
