import { useEffect, useRef } from 'react';
import { View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import styles from './index.module.scss';

type DemoFrameProps = {
  page: 'index.html' | 'customers.html' | 'management.html' | 'print.html';
  view?: 'stock' | 'finance' | 'suppliers';
};

const pageUrl = ({ page, view }: DemoFrameProps) => {
  const path = `preview-pages/${page}${view ? `?view=${view}` : ''}`;
  if (typeof window === 'undefined') return `/${path}`;
  const base = window.location.protocol === 'file:' ? window.location.href : window.location.origin + '/';
  return new URL(path, base).href;
};

const routeForFrame = (value: string) => {
  const url = new URL(value);
  const page = url.pathname.split('/').pop();
  if (page === 'customers.html') return '/pages/customers/index';
  if (page === 'print.html') return '/pages/print-center/index';
  if (page === 'management.html') {
    if (url.searchParams.get('view') === 'finance') return '/pages/finance/index';
    if (url.searchParams.get('view') === 'suppliers') return '/pages/suppliers/index';
    return '/pages/inventory/index';
  }
  return '/pages/home/index';
};

export default function DemoFrame(props: DemoFrameProps) {
  const url = pageUrl(props);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const element = frame.current;
    if (element) element.src = url;
  }, [url]);

  const syncRoute = () => {
    const element = frame.current;
    if (!element?.contentWindow) return;
    const target = routeForFrame(element.contentWindow.location.href);
    const current = `/${(Taro.getCurrentPages().slice(-1)[0]?.route || '').replace(/^\/+/, '')}`;
    if (current !== target) void Taro.reLaunch({ url: target });
  };

  return <View className={styles.shell}>
    <iframe ref={frame} title='曙光库存业务页面' className={styles.frame} src={url} onLoad={syncRoute} />
  </View>;
}
