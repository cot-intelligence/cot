import { useMemo } from 'react';
import type { SessionDetail } from '../../../lib/api';
import { sessionRuns } from '../../../lib/sessionView';
import { InsightsTab } from './tabs/InsightsTab';
import { TimelineTab } from './tabs/TimelineTab';

interface SessionTabsProps {
  detail: SessionDetail;
  activeTab: string;
  onTabChange: (key: string) => void;
  focusEventId?: number;
  focusQuery?: string;
}

const TABS = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'insights', label: 'Insights' },
];

export function SessionTabs({ detail, activeTab, onTabChange, focusEventId, focusQuery }: SessionTabsProps) {
  const runs = useMemo(() => sessionRuns(detail), [detail]);

  const tabs = (
    <div className="seg shrink-0" role="tablist" aria-label="Session views">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.key}
          aria-pressed={activeTab === tab.key}
          onClick={() => onTabChange(tab.key)}
          className="seg-item">
          {tab.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {activeTab === 'insights' ? (
        <>
          <div className="shrink-0 border-y border-line/10 px-6 py-2.5 sm:px-8">
            <div className="mx-auto flex max-w-7xl items-center">{tabs}</div>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
            <div className="mx-auto max-w-7xl">
              <InsightsTab detail={detail} />
            </div>
          </div>
        </>
      ) : (
        <TimelineTab
          items={detail.events}
          runs={runs}
          focusEventId={focusEventId}
          focusQuery={focusQuery}
          sessionId={detail.summary.id}
          tabs={tabs}
        />
      )}
    </div>
  );
}
