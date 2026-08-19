import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSessionDetail } from '../../lib/api';
import { setDocumentTitle } from '../../lib/documentTitle';
import { SessionDetailSkeleton } from '../ui/Skeleton';
import { SessionMeta } from './session/SessionMeta';
import { SessionTabs } from './session/SessionTabs';

interface SessionDetailViewProps {
  sessionId: string;
  /** When set, open the timeline focused on this event (e.g. from search). */
  focusEventId?: number;
}

export function SessionDetailView({ sessionId, focusEventId }: SessionDetailViewProps) {
  const [activeTab, setActiveTab] = useState('timeline');

  // Cached per session id, so revisiting a session already viewed renders
  // instantly instead of dropping back to the skeleton. A previously-unseen
  // session has no cache entry yet, so it still shows the skeleton on first
  // load. The live stream (QueryProvider) keeps an active session fresh; the
  // interval is a safety-net fallback.
  const { data: detail } = useQuery({
    queryKey: ['sessionDetail', sessionId],
    queryFn: () => getSessionDetail(sessionId),
    refetchInterval: 15000,
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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Compact sticky header: session meta */}
      <div className="shrink-0 border-b border-line/10 px-6 py-4 sm:px-8">
        <div className="mx-auto max-w-7xl">
          <SessionMeta summary={detail.summary} links={detail.links} />
        </div>
      </div>

      {/* Tabs + content fill remaining height */}
      <SessionTabs
        detail={detail}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        focusEventId={focusEventId}
      />
    </div>
  );
}
