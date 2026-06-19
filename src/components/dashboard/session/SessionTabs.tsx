import { lazy, Suspense, useMemo } from 'react';
import type { SessionDetail } from '../../../lib/api';
import { subagentRuns } from '../../../lib/sessionView';
import { Icon } from '../../ui/icons';
import { TimelineTab } from './tabs/TimelineTab';

// Code-split: the Insights tab pulls in recharts; only load it when opened.
const InsightsTab = lazy(() =>
  import('./tabs/InsightsTab').then((m) => ({ default: m.InsightsTab })),
);

interface SessionTabsProps {
  detail: SessionDetail;
  activeTab: string;
  onTabChange: (key: string) => void;
  focusEventId?: number;
}

export function SessionTabs({ detail, activeTab, onTabChange, focusEventId }: SessionTabsProps) {
  const current = activeTab === 'insights' ? 'insights' : 'timeline';
  // Run windows come from the merged timeline (start/end paired into spans);
  // detail.events is unmerged, so it would double-count Pre/Post. Feeds the
  // Timeline tab's main-vs-subagent lane filter.
  const runs = useMemo(() => subagentRuns(detail.timeline), [detail.timeline]);

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onTabChange('timeline')}
          className={`flex items-center gap-2 rounded-md px-3.5 py-2 font-mono text-[0.7rem] font-bold uppercase tracking-widest transition-colors ${
            current === 'timeline'
              ? 'bg-fg text-bg shadow-soft'
              : 'text-fg/55 hover:text-fg'
          }`}>
          <Icon name="clock" className="h-3.5 w-3.5" />
          Timeline
          <span className={current === 'timeline' ? 'text-bg/60' : 'text-fg/40'}>
            {detail.events.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onTabChange('insights')}
          className={`flex items-center gap-2 rounded-md px-3.5 py-2 font-mono text-[0.7rem] font-bold uppercase tracking-widest transition-colors ${
            current === 'insights'
              ? 'bg-fg text-bg shadow-soft'
              : 'text-fg/55 hover:text-fg'
          }`}>
          <Icon name="brain" className="h-3.5 w-3.5" />
          Insights
        </button>
      </div>

      <div>
        {current === 'timeline' && (
          <TimelineTab items={detail.events} runs={runs} focusEventId={focusEventId} />
        )}
        {current === 'insights' && (
          <Suspense
            fallback={<p className="font-mono text-xs text-fg/40">Loading insights…</p>}>
            <InsightsTab detail={detail} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
