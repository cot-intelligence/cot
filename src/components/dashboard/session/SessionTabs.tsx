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
}

const TABS = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'insights', label: 'Insights' },
];

export function SessionTabs({ detail, activeTab, onTabChange, focusEventId }: SessionTabsProps) {
  const runs = useMemo(() => sessionRuns(detail), [detail]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line/10 px-6 sm:px-8">
        <div className="mx-auto flex max-w-7xl gap-1.5 py-2" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => onTabChange(tab.key)}
              className={`flex h-8 items-center border px-2.5 font-mono text-[0.6rem] uppercase tracking-widest transition-colors focus-visible:border-vermilion focus-visible:outline-none ${
                activeTab === tab.key
                  ? 'border-fg/50 bg-surface text-fg'
                  : 'border-transparent text-fg/55 hover:border-fg/50 hover:text-fg'
              }`}>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'insights' ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          <div className="mx-auto max-w-7xl">
            <InsightsTab detail={detail} />
          </div>
        </div>
      ) : (
        <TimelineTab
          items={detail.events}
          runs={runs}
          focusEventId={focusEventId}
          sessionId={detail.summary.id}
        />
      )}
    </div>
  );
}
