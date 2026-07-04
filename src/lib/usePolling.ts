import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getStreamSnapshot, subscribeStream } from './useServerRevision';

// When the live stream is connected we still poll on this slow cadence as a
// safety net (in case a change event is missed), but freshness comes from the
// stream. When disconnected, the caller's own interval is used.
const CONNECTED_FALLBACK_MS = 30000;

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: React.DependencyList = [],
): { data: T | null; error: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const { revision, connected } = useSyncExternalStore(
    subscribeStream,
    getStreamSnapshot,
    getStreamSnapshot,
  );

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
    // Fetch on mount, on every server revision bump, and whenever connectivity
    // flips — so a `change` from the stream drives an immediate refetch.
    load();
    const effective = connected ? Math.max(intervalMs, CONNECTED_FALLBACK_MS) : intervalMs;
    if (effective > 0) {
      const t = window.setInterval(load, effective);
      return () => { active = false; window.clearInterval(t); };
    }
    return () => { active = false; };
  }, [intervalMs, connected, revision, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, error };
}
