import { useMemo } from 'react';
import type { SessionDetail } from '../../../lib/api';
import { subagentRuns } from '../../../lib/sessionView';
import { TimelineTab } from './tabs/TimelineTab';

interface SessionTabsProps {
  detail: SessionDetail;
  activeTab: string;
  onTabChange: (key: string) => void;
  focusEventId?: number;
}

export function SessionTabs({ detail, focusEventId }: SessionTabsProps) {
  const runs = useMemo(() => subagentRuns(detail.timeline), [detail.timeline]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TimelineTab
        items={detail.events}
        runs={runs}
        focusEventId={focusEventId}
        sessionId={detail.summary.id}
      />
    </div>
  );
}
