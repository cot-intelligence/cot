import { useEffect, type ReactNode } from 'react';
import { QueryClientProvider, type Query } from '@tanstack/react-query';
import { queryClient } from './queryClient';
import { subscribeStream, type StreamChange } from './useServerRevision';

// Coalesce bursts of live-change signals into at most one invalidation per
// window. A busy session emits many events per second; without this every one
// would refetch its detail and the lists. The collector pushes changes as they
// land (no polling delay there), so this window is the whole live latency.
const LIVE_COALESCE_MS = 1000;

// Aggregates over the whole history. Each costs the collector a scan of the
// events table, so a live ingest only marks them stale: a mounted view still
// refreshes on its own polling interval, and an unmounted one on next visit.
const HEAVY_KEYS = new Set([
  'metrics',
  'insights',
  'overview-window',
  'connections',
  'activity',
  'activityLog',
  'extensions',
  'extensionDetail',
  'sessionProjects',
]);

// Keys scoped to one session, and where its id sits in the key. They refetch
// only when that session changed.
const SESSION_KEY_ID: Record<string, (key: readonly unknown[]) => unknown> = {
  sessionDetail: (key) => key[key.length - 1], // ['sessionDetail', id] or ['sessionDetail', store, id]
  sessionExtensions: (key) => key[1],
  annotations: (key) => key[1],
  eventDetail: (key) => key[2], // ['eventDetail', store, sessionId, eventId]
};

/** Coalesced: `null` = anything may have changed, else the changed session ids. */
type Pending = Set<string> | null;

function invalidate(changed: Pending): void {
  const root = (q: Query) => String(q.queryKey[0]);
  void queryClient.invalidateQueries({ predicate: (q) => HEAVY_KEYS.has(root(q)), refetchType: 'none' });
  void queryClient.invalidateQueries({
    predicate: (q) => {
      const name = root(q);
      if (HEAVY_KEYS.has(name)) return false;
      const idOf = SESSION_KEY_ID[name];
      if (!idOf) return true;
      return changed === null || changed.has(String(idOf(q.queryKey)));
    },
  });
}

/**
 * Wraps the app in react-query and bridges the collector's live stream to the
 * cache. A change refetches the lists and counts, plus the detail of only the
 * sessions that changed; whole-history aggregates are marked stale instead. A
 * hidden page defers its refetch until it is shown again. This is what keeps
 * served-from-cache data from going stale without refetching every view on
 * every ingest.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let timer: number | null = null;
    let pending: Pending | undefined;
    const flush = () => {
      timer = null;
      if (pending === undefined) return;
      if (document.visibilityState === 'hidden') return; // flushed on visibilitychange
      const changed = pending;
      pending = undefined;
      invalidate(changed);
    };
    const unsubscribe = subscribeStream((change: StreamChange) => {
      if (change.sessions === null || pending === null) pending = null;
      else {
        pending ??= new Set();
        change.sessions.forEach((id) => (pending as Set<string>).add(id));
      }
      if (timer !== null) return;
      timer = window.setTimeout(flush, LIVE_COALESCE_MS);
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') flush();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe();
    };
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
