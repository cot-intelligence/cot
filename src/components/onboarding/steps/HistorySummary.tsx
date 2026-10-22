import { useEffect, useState } from 'react';
import { getImportSummary, type ImportSummary } from '../../../lib/api';
import { sourceLabel } from '../../../lib/sourceLabels';
import { AgentMark } from '../../forest/AgentMark';
import { fmt } from '../../forest/format';

const POLL_MS = 2000;
const TIMEOUT_MS = 15000;

export type HistoryState = 'scanning' | 'found' | 'empty';

/** Polls the import summary until sessions show up, or gives up quietly after TIMEOUT_MS. */
export function useImportHistory(): { summary: ImportSummary | null; state: HistoryState } {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const data = await getImportSummary();
        if (!active) return;
        setSummary(data);
        if (data.sessions > 0) return;
      } catch {
        /* the collector may still be starting */
      }
      if (active) timer = window.setTimeout(poll, POLL_MS);
    };
    poll();
    const timeout = window.setTimeout(() => active && setTimedOut(true), TIMEOUT_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearTimeout(timeout);
    };
  }, []);
  const state: HistoryState = summary && summary.sessions > 0 ? 'found' : timedOut ? 'empty' : 'scanning';
  return { summary, state };
}

const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

/** The history cot found: four facts, then a line per agent. A skeleton of the same shape while it scans. */
export function HistorySummary({ summary, state }: { summary: ImportSummary | null; state: HistoryState }) {
  if (state === 'scanning') {
    return (
      <div className="onb-hist" aria-busy="true" aria-label="Looking for past sessions">
        <div className="onb-sum">
          {[0, 1, 2, 3].map((i) => <div key={i} className="onb-sk"><span /><span /></div>)}
        </div>
      </div>
    );
  }
  if (state === 'empty' || !summary) {
    return <p className="onb-note">No past sessions yet. New ones appear as you use your agents.</p>;
  }
  return (
    <div className="onb-hist">
      <dl className="onb-sum">
        <div><dt>Sessions</dt><dd className="mono">{fmt.n(summary.sessions)}</dd></div>
        <div><dt>Tokens</dt><dd className="mono" title={fmt.n(summary.tokens.total)}>{fmt.k(summary.tokens.total)}</dd></div>
        <div><dt>From</dt><dd>{day(summary.earliest)}</dd></div>
        <div><dt>To</dt><dd>{day(summary.latest)}</dd></div>
      </dl>
      {summary.by_source.length > 0 && (
        <ul className="onb-src">
          {summary.by_source.map((s) => (
            <li key={s.source}>
              <AgentMark id={s.source} size={14} />
              <span>{sourceLabel(s.source)}</span>
              <span className="mono faint">{fmt.n(s.sessions)} sessions · {fmt.n(s.events)} events</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
