import { useEffect, useRef, useState } from 'react';

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: React.DependencyList = [],
): { data: T | null; error: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const d = await fetcherRef.current();
        if (active) { setData(d); setError(false); }
      } catch {
        if (active) setError(true);
      }
    };
    load();
    if (intervalMs > 0) {
      const t = window.setInterval(load, intervalMs);
      return () => { active = false; window.clearInterval(t); };
    }
    return () => { active = false; };
  }, [intervalMs, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, error };
}
