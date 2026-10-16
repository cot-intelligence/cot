import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { getSessionDetail, type SessionDetail, type SessionPage, type SessionSummary, type Store } from './api';

// One cache entry per session detail, shared by the trace page, the sessions
// list's peek drawer and hover prefetch, so whichever asks first pays for it.
export function sessionDetailKey(sessionId: string, store: Store = 'main'): unknown[] {
  return store === 'main' ? ['sessionDetail', sessionId] : ['sessionDetail', store, sessionId];
}

/** Warm the cache for a session the pointer or focus is on, ahead of the click. */
export function prefetchSessionDetail(queryClient: QueryClient, sessionId: string): void {
  void queryClient.prefetchQuery({
    queryKey: sessionDetailKey(sessionId),
    queryFn: () => getSessionDetail(sessionId),
    staleTime: 30_000,
  });
}

/**
 * Prefetch a row's detail once the pointer has rested on it (or it took focus)
 * for a moment: long enough that sweeping across the list fetches nothing, short
 * enough to land well before most clicks.
 */
export function useHoverPrefetch(delayMs = 120): { start: (sessionId: string) => void; cancel: () => void } {
  const queryClient = useQueryClient();
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return useMemo(() => {
    const cancel = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    const start = (sessionId: string) => {
      cancel();
      timer.current = window.setTimeout(() => prefetchSessionDetail(queryClient, sessionId), delayMs);
    };
    return { start, cancel };
  }, [queryClient, delayMs]);
}

/** The session's row from any sessions list already in the cache. */
export function cachedSessionSummary(queryClient: QueryClient, sessionId: string): SessionSummary | undefined {
  for (const q of queryClient.getQueryCache().findAll({
    predicate: (query) => ['sessionsTable', 'sessions'].includes(String(query.queryKey[0])),
  })) {
    const data = q.state.data as SessionPage | SessionSummary[] | undefined;
    const rows = Array.isArray(data) ? data : data?.sessions;
    const hit = rows?.find((r) => r.id === sessionId);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * A stand-in detail built from the list row: enough for the trace page's header
 * and figures to paint at once while the events load. Render it as a
 * placeholder (react-query's isPlaceholderData), never as the real thing.
 */
export function seededSessionDetail(summary: SessionSummary): SessionDetail {
  return {
    summary,
    links: { parents: [], children: [] },
    components: {
      files_edited: [],
      files_read: [],
      skills_context: [],
      mcp_plugins: [],
      web_calls: [],
      subagents: [],
      shell_count: 0,
      prompt_count: 0,
      response_count: 0,
    },
    events: [],
    timeline_runs: [],
    clarifications: [],
  };
}
