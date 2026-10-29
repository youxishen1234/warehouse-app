import { useEffect } from 'react';
import Taro from '@tarojs/taro';
import './app.scss';

const routes = new Set([
  '/pages/home/index',
  '/pages/customers/index',
  '/pages/inventory/index',
  '/pages/finance/index',
  '/pages/suppliers/index',
  '/pages/print-center/index'
]);

export default function App({ children }) {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const path = window.location.hash.replace(/^#/, '').split('?')[0];
    if (path && path.startsWith('/pages/') && !routes.has(path)) {
      void Taro.reLaunch({ url: '/pages/home/index' });
    }
  }, []);

  return children;
}
