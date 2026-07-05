import { useEffect, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './queryClient';
import { subscribeStream } from './useServerRevision';

// Coalesce bursts of live-change signals into at most one invalidation per
// window. A busy session emits many events per second; without this every one
// would refetch all active queries.
const LIVE_COALESCE_MS = 1500;

/**
 * Wraps the app in react-query and bridges the collector's live stream to the
 * cache: whenever the collector reports new data (or we reconnect), every query
 * is invalidated, so mounted views refetch immediately and cached-but-unmounted
 * views refetch the next time they're shown. This is what keeps served-from-
 * cache data from going stale.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      void queryClient.invalidateQueries();
    };
    const unsubscribe = subscribeStream(() => {
      if (timer !== null) return;
      timer = window.setTimeout(flush, LIVE_COALESCE_MS);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
