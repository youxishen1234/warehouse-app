import { useEffect, useRef } from 'react';
const listeners = new Set<(revision?: string) => void>();
let lastRevision: string | undefined;
let queued = false;
let queuedRevision: string | undefined;
let pendingRefresh = false;
const FORCE_REFRESH = '__refresh__';
export function refreshSharedData(revision?: string) {
  if (revision !== undefined && revision === lastRevision) return;
  if (revision !== undefined) lastRevision = revision;
  queuedRevision = revision ?? FORCE_REFRESH;
  if (queued) return;
  queued = true;
  const flush = () => {
    queued = false;
    const nextRevision = queuedRevision;
    queuedRevision = undefined;
    if (!listeners.size) {
      pendingRefresh = true;
      queuedRevision = nextRevision;
      return;
    }
    listeners.forEach(fn => fn(nextRevision));
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(flush);
  else Promise.resolve().then(flush);
}
export function useSharedRefresh(load: (revision?: string) => any) {
  const ref = useRef(load); ref.current = load;
  useEffect(() => {
    const fn = (revision?: string) => ref.current(revision);
    listeners.add(fn);
    if (pendingRefresh) {
      pendingRefresh = false;
      const revision = queuedRevision;
      queuedRevision = undefined;
      Promise.resolve().then(() => ref.current(revision));
    }
    return () => { listeners.delete(fn); };
  }, []);
}
