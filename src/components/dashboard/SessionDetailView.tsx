import { useEffect, useState } from 'react';
import { getSessionDetail, type SessionDetail } from '../../lib/api';
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
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [activeTab, setActiveTab] = useState('timeline');

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

  useEffect(() => {
    setDetail(null); // show the skeleton while a freshly-selected session loads
    let active = true;
    const load = async () => {
      try {
        const data = await getSessionDetail(sessionId);
        if (active) setDetail(data);
      } catch {
        if (active) setDetail(null);
      }
    };
    load();
    const t = window.setInterval(load, 3000);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, [sessionId]);

  if (!detail) {
    return <SessionDetailSkeleton />;
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Compact sticky header: session meta */}
      <div className="shrink-0 border-b border-line/10 px-6 py-4 sm:px-8">
        <div className="mx-auto max-w-7xl">
          <SessionMeta summary={detail.summary} />
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
