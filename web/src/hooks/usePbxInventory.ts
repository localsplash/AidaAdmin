import { useCallback, useEffect, useRef, useState } from 'react';

/** Screens are keyed by tenant. Late reads and mutations cannot update an unmounted tenant. */
export function usePbxInventory<T>(tenantId: string, loader: (tenantId: string) => Promise<T>) {
  const active = useRef(false);
  const sequence = useRef(0);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const current = useCallback(() => active.current, []);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (active.current) setLoading(true);
    try {
      const result = await loader(tenantId);
      if (active.current && request === sequence.current) {
        setData(result);
        setError(null);
      }
      return result;
    } catch (err) {
      if (active.current && request === sequence.current) setError(err);
      return null;
    } finally {
      if (active.current && request === sequence.current) setLoading(false);
    }
  }, [tenantId, loader]);
  useEffect(() => {
    const counter = sequence;
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      counter.current++;
    };
  }, [refresh]);
  return { data, error, loading, refresh, current };
}
