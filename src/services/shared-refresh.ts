import { useEffect, useRef } from 'react';
const listeners = new Set<() => void>();
export function refreshSharedData() { listeners.forEach(fn => fn()); }
export function useSharedRefresh(load: () => any) {
  const ref = useRef(load); ref.current = load;
  useEffect(() => { const fn = () => ref.current(); listeners.add(fn); return () => { listeners.delete(fn); }; }, []);
}
