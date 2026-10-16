import { dehydrate, hydrate, type Query, type QueryClient } from '@tanstack/react-query';

// Opening or reloading the dashboard paints the last-known lists and counts
// from this browser's storage at once, then revalidates them: the live stream's
// `hello` on connect invalidates everything, so nothing stale lingers. Only
// small, list-shaped queries are kept (never session details or event bodies),
// so the store stays far under the storage quota.
const STORAGE_KEY = 'cot.queryCache.v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WRITE_DELAY_MS = 2000;
const PERSISTED = new Set([
  'stats',
  'sessionsTable',
  'sessionProjects',
  'metrics',
  'insights',
  'overview-window',
  'connections',
  'health',
  'hookStatus',
]);

interface Stored {
  savedAt: number;
  state: ReturnType<typeof dehydrate>;
}

function persistable(query: Query): boolean {
  return query.state.status === 'success' && PERSISTED.has(String(query.queryKey[0]));
}

/** Restore the saved cache into ``queryClient`` (before the first render), then
 * keep saving it as queries settle. Storage may be unavailable (private mode,
 * blocked site data): then this does nothing. */
export function persistQueryCache(queryClient: QueryClient): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Stored;
      if (Date.now() - stored.savedAt < MAX_AGE_MS) hydrate(queryClient, stored.state);
      else window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // A corrupt or unreadable entry: start empty.
  }

  let timer: number | null = null;
  const save = () => {
    timer = null;
    try {
      const state = dehydrate(queryClient, { shouldDehydrateQuery: persistable });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), state } satisfies Stored));
    } catch {
      // Quota or storage blocked: the dashboard works the same without it.
    }
  };
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || !PERSISTED.has(String(event.query.queryKey[0]))) return;
    if (timer === null) timer = window.setTimeout(save, WRITE_DELAY_MS);
  });
}
