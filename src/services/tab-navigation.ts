import { createGlassTabBar } from './glass-tabbar';

// Keep this list aligned with app.config.ts and the custom glass dock.
export const tabRoutes = ['/pages/home/index', '/pages/ai-assistant/index', '/pages/inventory/index', '/pages/print-center/index', '/pages/mine/index'];

export function normalizeRoute(value: string): string {
  return '/' + value.replace(/^#?\/?/, '').split(/[?#]/)[0].replace(/\/$/, '');
}

type Navigation = {
  route: () => string;
  switchTab: (url: string) => Promise<unknown>;
  navigateTo: (url: string) => Promise<unknown>;
  back: () => Promise<unknown>;
  depth: () => number;
};

// One gesture owner for browser, Android and iOS, independent of dock visibility.
export function installTabNavigation(nav: Navigation): () => void {
  const root = document.documentElement;
  const win = window as any;
  let busy = false;
  let queued: { url: string; requestId?: number } | null = null;
  let acknowledgedRequest: number | undefined;
  let navigationFailed = false;
  let lastNativeState = '';
  let frame = 0;
  let state: { x: number; y: number; dx: number; locked: boolean; index: number; page: HTMLElement; back: boolean; ownerAlias: boolean } | null = null;
  let suppressClickUntil = 0;
  let disposed = false;
  let dock: ReturnType<typeof createGlassTabBar> | null = null;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const android = /Android/i.test(navigator.userAgent) || win.Capacitor?.getPlatform?.() === 'android';
  const route = () => normalizeRoute(nav.route());
  const visiblePage = (element: HTMLElement) => getComputedStyle(element).display !== 'none'
    && element.getBoundingClientRect().width > 0;
  const activePage = () => Array.from(document.querySelectorAll<HTMLElement>('.taro_page')).reverse().find(visiblePage);
  const pageFor = (actual: string) => Array.from(document.querySelectorAll<HTMLElement>('.taro_page'))
    .find(element => normalizeRoute(element.id) === actual && visiblePage(element));
  const modalOpen = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], .sg-calc-overlay, .taro-modal, [class*="mask___"]'))
    .some(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0);
  const ownedRoute = (actual: string) => {
    if (tabRoutes.includes(actual)) return actual;
    const page = pageFor(actual);
    const declared = page?.getAttribute('data-tab-route')
      || page?.querySelector<HTMLElement>('[data-tab-route]')?.dataset.tabRoute;
    const owner = declared ? normalizeRoute(declared) : '';
    return tabRoutes.includes(owner) ? owner : actual;
  };

  const sync = () => {
    if (disposed) return;
    const modal = modalOpen();
    root.toggleAttribute('data-tab-modal', modal);
    if (['/pages/home/index', '/pages/business-center/index', '/pages/customers/index', '/pages/suppliers/index', '/pages/inventory/index'].includes(route())) {
      root.setAttribute('data-workbench-shell', '');
    } else {
      root.removeAttribute('data-workbench-shell');
    }
    const actual = route();
    const owner = ownedRoute(actual);
    const ownerIndex = tabRoutes.indexOf(owner);
    // Taro hides its tab host on every non-tab page. A page can explicitly
    // claim a main-tab context without changing its real route.
    if (ownerIndex >= 0 && !tabRoutes.includes(actual)) root.setAttribute('data-tab-context', '');
    else root.removeAttribute('data-tab-context');
    // Taro's shade class normally clears at transitionend. Our full-screen
    // WebView disables those transitions, so returning from a subpage must also
    // reveal the acknowledged tab explicitly.
    if (!busy && ownerIndex >= 0) {
      document.querySelectorAll<HTMLElement>('.taro_page').forEach(page => {
        if (normalizeRoute(page.id) === actual && page.classList.contains('taro_page_shade')) page.classList.remove('taro_page_shade');
      });
    }
    const capability = win.__sgNativeDock;
    const bridge = win.webkit?.messageHandlers?.nativeTabSelected;
    const native = capability?.api === 2 && bridge;
    root.classList.toggle('sg-native-ios', !!native);
    const host = document.querySelector<HTMLElement>('taro-tabbar');
    if (dock && dock.host !== host) { dock.destroy(); dock = null; }
    if (host && !dock) dock = createGlassTabBar(host, index => { void switchTo(tabRoutes[index]); }, url => { void switchTo(url, undefined, true); });
    if (!state?.locked && !busy) dock?.update(Math.max(0, ownerIndex));
    if (native) {
      root.style.setProperty('--sg-native-bottom-space', String(capability.bottomSpace ?? 84) + 'px');
    }
    // A route is acknowledged only after its navigation settles. Sending the
    // previous route during selection makes UIKit snap its glass lens back.
    if (capability && bridge && !busy && !queued) {
      const message = { route: owner, ready: true, modal, requestId: acknowledgedRequest, navigationFailed };
      const serialized = JSON.stringify(message);
      if (serialized !== lastNativeState) {
        lastNativeState = serialized;
        bridge.postMessage(message);
      }
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
  const switchTo = async (url: string, requestId?: number, business = false) => {
    if (disposed || (!tabRoutes.includes(url) && !business)) return;
    // Keep the most recent destination while Taro is switching. Native drag
    // and rapid taps must not lose their final selection to a busy guard.
    queued = { url, requestId };
    if (busy) return;
    busy = true;
    try {
      while (queued && !disposed) {
        const target: { url: string; requestId?: number } = queued;
        queued = null;
        navigationFailed = false;
        acknowledgedRequest = target.requestId;
        try {
          if (modalOpen()) { navigationFailed = true; continue; }
          if (target.url !== route()) {
            if (tabRoutes.includes(target.url)) await nav.switchTab(target.url);
            else await nav.navigateTo(target.url);
          }
        } catch (error) {
          navigationFailed = true;
          console.error('[Navigation]', error);
        }
      }
    } finally { busy = false; scheduleSync(); }
  };
  const nativeSelect = (event: Event) => {
    const selection = event as CustomEvent<string> & { requestId?: number };
    void switchTo(selection.detail, selection.requestId);
  };
  const nativeReady = () => { lastNativeState = ''; scheduleSync(); };
  const cancel = () => {
    const current = state;
    state = null;
    if (current) { restore(current.page); dock?.update(Math.max(0, current.index)); }
  };
  const start = (event: TouchEvent) => {
    if (busy || event.touches.length !== 1) { cancel(); return; }
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, button, a, video, [role="button"], taro-button-core, taro-input-core, taro-picker-core, taro-textarea-core, .weui-tabbar, .sg-glass-dock, [class*="wrap___"], [data-no-tab-swipe]') || modalOpen()) return;
    const touch = event.touches[0];
    const actual = route();
    const owner = ownedRoute(actual);
    const index = tabRoutes.indexOf(owner);
    const back = !android && !tabRoutes.includes(actual) && nav.depth() > 1 && touch.clientX < 35;
    // Reserve both Android system-back edges. Tab gestures also stay central on iOS.
    if (!back && (touch.clientX < 50 || touch.clientX > innerWidth - 50)) return;
    const page = activePage();
    if (!page || (index < 0 && !back)) return;
    state = { x: touch.clientX, y: touch.clientY, dx: 0, locked: false, index, page, back, ownerAlias: index >= 0 && owner !== actual };
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
    const returningOwner = state.ownerAlias && dx > 0;
    const amount = !state.back && !returningOwner && (next < 0 || next >= tabRoutes.length) ? dx * .2 : dx;
    state.page.style.setProperty('transform', 'translate3d(' + amount + 'px,0,0)', 'important');
    if (!state.back) dock?.preview(state.index - dx / innerWidth);
  };
  const end = async (event: TouchEvent) => {
    if (event.touches.length || event.changedTouches.length !== 1) { cancel(); return; }
    const current = state;
    state = null;
    if (!current?.locked) return;
    suppressClickUntil = Date.now() + 350;
    const next = current.index + (current.dx < 0 ? 1 : -1);
    const returningOwner = current.ownerAlias && current.dx > 0;
    const destination = returningOwner ? current.index : next;
    const commit = Math.abs(current.dx) >= 64 && (current.back || returningOwner || (next >= 0 && next < tabRoutes.length));
    busy = true;
    if (!current.back) dock?.update(commit ? destination : current.index);
    try {
      await animate(current.page, commit ? (current.dx < 0 ? -innerWidth : innerWidth) : 0);
      if (commit && !disposed) {
        await (current.back ? nav.back() : nav.switchTab(tabRoutes[destination]));
      }
    } catch (error) { console.error('[Navigation]', error); }
    finally {
      restore(current.page);
      busy = false;
      if (queued && !disposed) void switchTo(queued.url, queued.requestId, true);
      else scheduleSync();
    }
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
  window.addEventListener('sg-native-ready', nativeReady);
  window.addEventListener('hashchange', scheduleSync);
  window.addEventListener('popstate', scheduleSync);
  // Taro can finish an old hide timer after navigateBack has revealed the tab.
  // Watch page classes too, without reacting to the dock's animated classes.
  const observer = new MutationObserver(mutations => {
    if (mutations.some(mutation => mutation.type === 'childList'
      || (mutation.target instanceof HTMLElement && mutation.target.classList.contains('taro_page')))) scheduleSync();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  sync();
  return () => {
    disposed = true;
    root.removeAttribute('data-workbench-shell');
    queued = null;
    cancel();
    cancelAnimationFrame(frame);
    observer.disconnect();
    dock?.destroy();
    root.removeAttribute('data-tab-context');
    root.removeAttribute('data-tab-modal');
    window.removeEventListener('touchstart', start, true);
    window.removeEventListener('touchmove', move, true);
    window.removeEventListener('touchend', end, true);
    window.removeEventListener('touchcancel', cancel, true);
    window.removeEventListener('click', blockClick, true);
    window.removeEventListener('sg-native-tab', nativeSelect);
    window.removeEventListener('sg-native-ready', nativeReady);
    window.removeEventListener('hashchange', scheduleSync);
    window.removeEventListener('popstate', scheduleSync);
  };
}
