import { keepPreviousData, useQuery, type QueryKey } from '@tanstack/react-query';

// Never poll faster than this even if a caller asks. The live stream (wired in
// QueryProvider) drives freshness; the interval is only a safety net for missed
// events / reconnects.
const FALLBACK_MIN_MS = 15000;

/**
 * Cached, live-updating fetch backed by react-query.
 *
 * `queryKey` identifies the data in the shared cache — include every value the
 * fetcher depends on (filters, ids, window) so changing one refetches, and so
 * two views asking for the same thing share one entry. Revisiting a view then
 * renders the cached result instantly while it revalidates in the background.
 *
 * Returns the same `{ data, error }` shape as before: `data` is the last
 * successful result (kept across refetches and key changes), `error` is true
 * when the current fetch failed.
 */
export function usePolling<T>(
  queryKey: QueryKey,
  fetcher: () => Promise<T>,
  intervalMs: number,
): { data: T | null; error: boolean } {
  const refetchInterval = intervalMs > 0 ? Math.max(intervalMs, FALLBACK_MIN_MS) : false;
  const { data, isError } = useQuery<T>({
    queryKey,
    queryFn: fetcher,
    refetchInterval,
    // Show the previous result (e.g. while a filter change loads) instead of
    // dropping back to a skeleton.
    placeholderData: keepPreviousData,
  });
  return { data: data ?? null, error: isError };
}
