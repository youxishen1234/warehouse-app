import { useEffect, useState } from 'react';
import { getLocalPrintBridge } from '@/utils/local-print';

export function isMobilePrintNotifications(): boolean {
  if (typeof window === 'undefined' || getLocalPrintBridge()) return false;
  if (/Electron/i.test(window.navigator?.userAgent || '')) return false;
  const capacitor = (window as any).Capacitor;
  if (capacitor?.isNativePlatform?.()) {
    const platform = capacitor.getPlatform?.();
    return !platform || platform === 'ios' || platform === 'android';
  }
  return window.innerWidth < 1024;
}

export function useMobilePrintNotifications(): boolean {
  const [mobile, setMobile] = useState(isMobilePrintNotifications);
  useEffect(() => {
    const resize = () => setMobile(isMobilePrintNotifications());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return mobile;
}
