import React, { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { isOffline, onOfflineChange, autoBestBase } from '@/services/request';
// 全局样式
import './app.scss';
import TeamAccess from '@/components/TeamAccess';

// 离线模式提示条：后端不可达且在使用本地缓存时展示，点击「重试」恢复在线
// 启动及离线期间每 15 秒自动在「局域网 → 隧道」候选地址间探测，
// 发现可达地址立即切换并自动消失
function OfflineBar() {
  const [offline, setOffline] = useState(isOffline());

  useEffect(() => {
    try { Taro.removeStorageSync('sg_api___offline'); } catch (e) { /* ignore */ }
    const off = onOfflineChange(setOffline);
    autoBestBase(); // 每次进入 App 自动探测：优先局域网，连不上走隧道
    const timer = setInterval(() => {
      if (isOffline()) {
        autoBestBase();
      }
    }, 15000);
    return () => { off(); clearInterval(timer); };
  }, []);

  if (!offline) return null;

  const retry = async () => {
    // 触发一次读接口探测连通性；成功后 setOffline(false) 会自动隐藏
    try {
      await import('@/services/api').then(m => m.getStats());
    } catch (e) { /* 仍离线，保持展示 */ }
  };

  return (
    <View className='sg-offline-bar'>
      <Text className='sg-offline-bar-text'>离线模式 · 展示本地缓存数据</Text>
      <Text className='sg-offline-retry' onClick={retry}>重试</Text>
    </View>
  );
}

// 全局返回助手：App 内子页面（navigateTo 打开）没有系统导航栏，
// iOS 也没有原生边缘返回手势，这里统一提供【左上角浮动返回按钮】+【左边缘右滑返回】
function BackNavigator() { return null; }

// Legacy edge-back implementation retained for reference; TabSwipeNavigator owns touch gestures.
function LegacyBackNavigator() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const refresh = () => {
      try { setShow(Taro.getCurrentPages().length > 1); } catch (e) {}
    };
    refresh();
    const timer = setInterval(refresh, 800);
    let clickCleanup: (() => void) | null = null;
    if (typeof document === 'undefined') {
      return () => clearInterval(timer);
    }

    try {
      const onClickRefresh = () => setTimeout(refresh, 350);
      document.addEventListener('click', onClickRefresh, true);
      clickCleanup = () => document.removeEventListener('click', onClickRefresh, true);
    } catch (e) { /* H5 专属，非 H5 环境跳过 */ }

    // ===== 左边缘右滑返回手势 =====
    // 触发条件：触摸起点在屏幕左边缘，横向右滑距离超过阈值
    // 支持 iOS/Android 均可用的统一返回手势；滑动过程带视觉反馈（左侧指示条）
    let startX = 0, startY = 0, dx = 0, dy = 0, tracking = false, locked = false;
    const EDGE = 32;      // 边缘触发宽度(px)
    const THRESHOLD = 60; // 触发返回的滑动距离(px)
    let hintEl: HTMLElement | null = null;

    const showHint = (p: number) => {
      if (!hintEl) {
        hintEl = document.createElement('div');
        // 液态玻璃返回光条：蓝色渐变 + 光晕，贴合 iOS Liquid Glass 观感
        hintEl.style.cssText =
          'position:fixed;left:0;top:0;bottom:0;width:16px;z-index:9998;pointer-events:none;transition:opacity 0.15s ease;' +
          'background:linear-gradient(90deg, rgba(47,107,255,0.55) 0%, rgba(120,170,255,0.28) 60%, rgba(255,255,255,0) 100%);' +
          'box-shadow:0 0 28px rgba(47,107,255,0.35);border-radius:0 14px 14px 0;';
        document.body.appendChild(hintEl);
      }
      hintEl.style.opacity = String(Math.max(0, Math.min(1, p)));
    };
    const hideHint = () => {
      if (hintEl) { hintEl.remove(); hintEl = null; }
    };

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      const canBack = (() => { try { return Taro.getCurrentPages().length > 1; } catch (err) { return false; } })();
      tracking = t.clientX <= EDGE && canBack;
      locked = false;
      if (tracking) { startX = t.clientX; startY = t.clientY; dx = 0; dy = 0; }
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      dx = t.clientX - startX;
      dy = t.clientY - startY;
      // 横向意图明确（右滑）时锁定手势，阻止页面纵向滚动干扰
      if (!locked && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) && dx > 0) {
        locked = true;
      }
      if (locked) {
        if (e.cancelable) e.preventDefault();
        showHint(dx / THRESHOLD);
      }
    };
    const finish = () => {
      if (tracking && locked && dx > THRESHOLD) {
        Taro.navigateBack({ delta: 1 }).catch(() => {});
      }
      hideHint();
      tracking = false; locked = false; dx = 0; dy = 0;
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', finish, { passive: true });
    document.addEventListener('touchcancel', finish, { passive: true });

    return () => {
      clearInterval(timer);
      if (clickCleanup) clickCleanup();
      hideHint();
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', finish);
      document.removeEventListener('touchcancel', finish);
    };
  }, []);

  if (!show) return null;
  return (
    <View
      className='sg-back-btn'
      onClick={() => Taro.navigateBack({ delta: 1 }).catch(() => {})}
    >
      <Text className='sg-back-icon'>‹</Text>
    </View>
  );
}

// 底部四个主页面支持左右横滑切换；只在 Tab 根页启用，不影响子页返回和列表左滑操作。
function TabSwipeNavigator() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const tabs = [
      '/pages/home/index',
      '/pages/inbound/index',
      '/pages/outbound/index',
      '/pages/mine/index'
    ];
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let active = false;
    let gestureMode: 'tab' | 'back' | '' = '';
    const isAndroid = /Android/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : '') || (() => { try { return (globalThis as any).Capacitor?.getPlatform?.() === 'android'; } catch (e) { return false; } })();
    const EDGE_GUARD = 50;
    // Android middle-area tabs are deliberately easy to switch; iOS keeps its prior feel.
    const TAB_SWIPE_THRESHOLD = isAndroid ? 50 : 72;
    if (isAndroid) document.documentElement.classList.add('sg-android-edge-system');
    const currentTabIndex = () => {
      let route = '';
      try { const page = Taro.getCurrentPages().slice(-1)[0]; route = page?.route ? String(page.route) : ''; } catch (e) { /* fallback below */ }
      if (!route && typeof location !== 'undefined') route = location.pathname;
      route = '/' + route.replace(/^\/+/, '');
      return tabs.findIndex(tab => route.includes(tab.replace('/pages', '')) || route === tab);
    };
    const notifyNativeTabSelection = () => {
      const index = currentTabIndex();
      const handler = (window as any).webkit?.messageHandlers?.nativeTabSelected;
      if (index >= 0 && handler) handler.postMessage(location.hash || tabs[index]);
    };
    const onNativeTabSelect = (event: Event) => {
      const url = (event as CustomEvent<string>).detail;
      if (typeof url === 'string' && tabs.includes(url)) Taro.switchTab({ url });
    };
    window.addEventListener('sg-native-tab', onNativeTabSelect);
    window.addEventListener('hashchange', notifyNativeTabSelection);
    window.addEventListener('popstate', notifyNativeTabSelection);

    const isInteractive = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return !!el?.closest('input, textarea, select, button, [role="button"]');
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || isInteractive(e.target)) { active = false; return; }
      const rootIndex = currentTabIndex();
      const touchX = e.touches[0].clientX;
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
      // Android owns both edge zones for system navigation; never claim them here.
      if (isAndroid && (touchX <= EDGE_GUARD || (viewportWidth > 0 && touchX >= viewportWidth - EDGE_GUARD))) { active = false; gestureMode = ''; return; }
      let stackDepth = 1;
      try { stackDepth = Taro.getCurrentPages().length; } catch (err) { /* fallback */ }
      gestureMode = rootIndex >= 0 ? 'tab' : (!isAndroid && stackDepth > 1 && touchX <= EDGE_GUARD ? 'back' : '');
      active = !!gestureMode;
      if (!active) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      dx = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const t = e.touches[0];
      dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (gestureMode === 'back' && dx < 0) return;
      // Let the page keep vertical scrolling; only claim a deliberate horizontal gesture.
      if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.5 && e.cancelable) e.preventDefault();
    };
    const onEnd = () => {
      if (!active) return;
      active = false;
      if (Math.abs(dx) < TAB_SWIPE_THRESHOLD) return;
      if (gestureMode === 'back') {
        if (dx > TAB_SWIPE_THRESHOLD) Taro.navigateBack({ delta: 1 }).catch(() => {});
        gestureMode = '';
        return;
      }
      const index = currentTabIndex();
      const next = dx < 0 ? index + 1 : index - 1;
      if (next >= 0 && next < tabs.length) Taro.switchTab({ url: tabs[next] });
    };

    let pointerStart = 0;
    let pointerY = 0;
    let pointerActive = false;
    let pointerMode: 'tab' | 'back' | '' = '';
    const pointerDown = (e: PointerEvent) => { if (e.pointerType === 'touch') { pointerStart = e.clientX; pointerY = e.clientY; const width = typeof window !== 'undefined' ? window.innerWidth : 0; if (isAndroid && (e.clientX <= EDGE_GUARD || (width > 0 && e.clientX >= width - EDGE_GUARD))) { pointerActive = false; pointerMode = ''; return; } let depth=1; try { depth=Taro.getCurrentPages().length; } catch (err) {} pointerMode=currentTabIndex()>=0?'tab':(!isAndroid&&depth>1&&e.clientX<=EDGE_GUARD?'back':''); pointerActive=!!pointerMode; } };
    const pointerUp = (e: PointerEvent) => { if (!pointerActive) return; pointerActive = false; const delta = e.clientX - pointerStart; if (Math.abs(delta) >= TAB_SWIPE_THRESHOLD && Math.abs(delta) > Math.abs(e.clientY - pointerY) * 1.35) { if(pointerMode==='back'){if(delta>TAB_SWIPE_THRESHOLD)Taro.navigateBack({delta:1}).catch(()=>{});return;} const i=currentTabIndex(); const n=delta<0?i+1:i-1; if(n>=0&&n<tabs.length) Taro.switchTab({url:tabs[n]}); } };

    window.addEventListener('touchstart', onStart, { passive: true, capture: true });
    window.addEventListener('touchmove', onMove, { passive: false, capture: true });
    window.addEventListener('touchend', onEnd, { passive: true, capture: true });
    window.addEventListener('touchcancel', onEnd, { passive: true, capture: true });
    window.addEventListener('pointerdown', pointerDown, { passive: true, capture: true });
    window.addEventListener('pointerup', pointerUp, { passive: true, capture: true });
    return () => {
      window.removeEventListener('touchstart', onStart, true);
      window.removeEventListener('touchmove', onMove, true);
      window.removeEventListener('touchend', onEnd, true);
      window.removeEventListener('touchcancel', onEnd, true);
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('pointerup', pointerUp, true);
      window.removeEventListener('sg-native-tab', onNativeTabSelect);
      window.removeEventListener('hashchange', notifyNativeTabSelection);
      window.removeEventListener('popstate', notifyNativeTabSelection);
      if (isAndroid) document.documentElement.classList.remove('sg-android-edge-system');
    };
  }, []);
  return null;
}

function App(props) {
  // 可以使用所有的 React Hooks
  useEffect(() => {});

  return (
    <TeamAccess>
      {props.children}
      <TabSwipeNavigator />
      <OfflineBar />
    </TeamAccess>
  );
}

export default App;
