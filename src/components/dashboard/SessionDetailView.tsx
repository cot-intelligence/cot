import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSessionDetail, setSessionBookmarked, type SessionDetail, type Store } from '../../lib/api';
import { setDocumentTitle } from '../../lib/documentTitle';
import { SessionStoreContext } from '../../lib/sessionStore';
import { SessionDetailSkeleton } from '../ui/Skeleton';
import { SessionMeta } from './session/SessionMeta';
import { SessionTabs } from './session/SessionTabs';

interface SessionDetailViewProps {
  sessionId: string;
  /** When set, open the timeline focused on this event (e.g. from search). */
  focusEventId?: number;
  /** Search text that led here; its first match in the focused event is scrolled into view. */
  focusQuery?: string;
  /** `replay` for a Session Replay import; everything on the page reads that DB. */
  store?: Store;
}

export function SessionDetailView({
  sessionId,
  focusEventId,
  focusQuery,
  store = 'main',
}: SessionDetailViewProps) {
  const [activeTab, setActiveTab] = useState('timeline');
  const queryClient = useQueryClient();

  // Cached per session id, so revisiting a session already viewed renders
  // instantly instead of dropping back to the skeleton. A previously-unseen
  // session has no cache entry yet, so it still shows the skeleton on first
  // load. The live stream (QueryProvider) keeps an active session fresh; the
  // interval is a safety-net fallback.
  // Imports never change, so only traced sessions poll.
  const { data: detail } = useQuery({
    queryKey: store === 'main' ? ['sessionDetail', sessionId] : ['sessionDetail', store, sessionId],
    queryFn: () => getSessionDetail(sessionId, store),
    refetchInterval: store === 'main' ? 15000 : false,
  });

  // Reset to the timeline on a new session, or when focusing a specific event.
  useEffect(() => {
    setActiveTab('timeline');
  }, [sessionId, focusEventId]);

  useEffect(() => {
    if (!detail) {
      setDocumentTitle('Session');
      return;
    }
    const label = detail.summary.title?.trim() || detail.summary.id.slice(0, 16);
    setDocumentTitle(label);
  }, [detail, sessionId]);

  if (!detail) {
    return <SessionDetailSkeleton />;
  }

  const toggleBookmark = async () => {
    const key = ['sessionDetail', sessionId];
    const next = !detail.summary.bookmarked;
    queryClient.setQueryData<SessionDetail>(key, (prev) =>
      prev ? { ...prev, summary: { ...prev.summary, bookmarked: next } } : prev,
    );
    try {
      await setSessionBookmarked(sessionId, next);
    } finally {
      queryClient.invalidateQueries({ queryKey: key });
    }
  };

  return (
    <SessionStoreContext.Provider value={store}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Compact sticky header: session meta */}
        <div className="shrink-0 px-6 pb-4 pt-5 sm:px-8">
          <div className="mx-auto max-w-7xl">
            <SessionMeta
              summary={detail.summary}
              links={detail.links}
              onToggleBookmark={store === 'main' ? toggleBookmark : undefined}
            />
          </div>
        </div>

        {/* Tabs + content fill remaining height */}
        <SessionTabs
          detail={detail}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          focusEventId={focusEventId}
          focusQuery={focusQuery}
        />
      </div>
    </SessionStoreContext.Provider>
  );
}
