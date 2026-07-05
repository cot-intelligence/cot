import { QueryClient } from '@tanstack/react-query';

// Shared cache for all dashboard data. Navigating between views (sessions,
// overview, settings, …) unmounts the previous view, so its data used to be
// discarded and refetched from scratch. Holding it here keeps revisits instant
// while the live stream (see QueryProvider) drives correctness.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Serve cache without a refetch for this long. Freshness does NOT rely on
      // this window: the collector's SSE stream invalidates everything the
      // instant real data changes, so staleTime only dedupes rapid navigation.
      staleTime: 30_000,
      // Keep an unmounted view's data cached for a few minutes so bouncing
      // between pages doesn't re-hit the collector.
      gcTime: 5 * 60_000,
      // The collector is local; surface "offline" quickly instead of a long
      // exponential-backoff retry chain, but tolerate a single transient blip.
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});
