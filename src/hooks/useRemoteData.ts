import { useCallback, useEffect, useRef, useState } from 'react';

type Loader<T> = () => Promise<T>;

type RemoteData<T> = {
  data: T;
  loading: boolean;
  ready: boolean;
  loadError: string;
  reload: () => Promise<void>;
};

/** Shared sequence guarded loader for pages with one remote data source. */
export function useRemoteData<T>(loader: Loader<T>, initialData: T): RemoteData<T> {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const sequence = useRef(0);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    const current = ++sequence.current;
    if (mounted.current) {
      setLoading(true);
      setLoadError('');
    }
    try {
      const next = await loader();
      if (!mounted.current || current !== sequence.current) return;
      setData(next);
    } catch (error) {
      if (!mounted.current || current !== sequence.current) return;
      setLoadError(error instanceof Error ? error.message : '加载失败，请点击重试');
    } finally {
      if (mounted.current && current === sequence.current) setLoading(false);
    }
  }, [loader]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [reload]);

  return { data, loading, ready: !loading && !loadError, loadError, reload };
}
