import { useEffect, useRef, useState } from 'react';
import { subscribeStream } from './useServerRevision';

// The live stream drives freshness, so poll only rarely as a safety net (missed
// events, reconnects). Never poll faster than this even if a caller asks.
const FALLBACK_MIN_MS = 15000;
// Coalesce bursts of live-change signals into at most one refetch per window. A
// busy session can emit many events per second; without this the dashboard would
// refetch expensive queries on every one.
const LIVE_COALESCE_MS = 1500;

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
    let lastLoad = 0;
    let coalesceTimer: number | null = null;

    const load = async () => {
      lastLoad = Date.now();
      try {
        const d = await fetcherRef.current();
        if (active) { setData(d); setError(false); }
      } catch {
        if (active) setError(true);
      }
    };

    // Throttled reload driven by the live stream: at most one refetch per
    // LIVE_COALESCE_MS, so a flood of change signals collapses to one fetch.
    const requestReload = () => {
      if (coalesceTimer !== null) return;
      const wait = Math.max(0, LIVE_COALESCE_MS - (Date.now() - lastLoad));
      coalesceTimer = window.setTimeout(() => {
        coalesceTimer = null;
        load();
      }, wait);
    };

    load();
    const unsubscribe = subscribeStream(requestReload);
    const fallbackMs = intervalMs > 0 ? Math.max(intervalMs, FALLBACK_MIN_MS) : 0;
    const fallback = fallbackMs > 0 ? window.setInterval(load, fallbackMs) : null;

    return () => {
      active = false;
      if (coalesceTimer !== null) window.clearTimeout(coalesceTimer);
      if (fallback !== null) window.clearInterval(fallback);
      unsubscribe();
    };
  }, [intervalMs, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, error };
}
