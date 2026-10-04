import { useDidShow } from '@tarojs/taro';
import { View } from '@tarojs/components';

export default function LabelPrintPage() {
  useDidShow(() => {
    if (typeof window === 'undefined') return;
    const base = new URL(document.baseURI);
    const routeAt = base.pathname.indexOf('/pages/');
    if (routeAt >= 0) base.pathname = base.pathname.slice(0, routeAt + 1);
    else if (base.pathname.endsWith('/index.html')) base.pathname = base.pathname.slice(0, -10);
    base.search = '';
    base.hash = '';
    const target = new URL('spec-test.html', base);
    const native = (globalThis as any).Capacitor?.isNativePlatform?.() || window.location.protocol === 'file:';
    if (native) target.searchParams.set('client', 'app');
    const route = window.location.hash;
    const queryAt = route.indexOf('?');
    const params = new URLSearchParams(queryAt >= 0 ? route.slice(queryAt + 1) : window.location.search);
    params.delete('client');
    target.hash = params.toString();
    window.location.replace(target.href);
  });
  return <View>正在打开标签打印...</View>;
}
