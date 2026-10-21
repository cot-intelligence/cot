import { useEffect, useMemo, useState } from 'react';
import { getSessionInsights, type ActionableInsight, type InsightSeverity, type SessionDetail, type TimelineItem } from '../../../../lib/api';
import { formatDateTime } from '../../../../lib/categoryMeta';
import { stepName } from '../../../../lib/flowGraph';
import { sessionHref, useSessionStore } from '../../../../lib/sessionStore';
import { parentTimelineItems } from '../../../../lib/sessionView';
import { CATEGORY_ICON, Icon } from '../../../forest/icons';
import { TONE } from '../../../ui/tone';

/**
 * A session's Findings tab: only what asks for action. The rule findings for
 * this session (what happened, why it matters, the fix, and the events behind
 * it), then the steps that failed. Totals, charts and files live in the header
 * and the other tabs.
 */

interface InsightsTabProps {
  detail: SessionDetail;
}

const SEVERITY_ORDER: Record<InsightSeverity, number> = { critical: 0, warn: 1, info: 2 };
const FAILED_SHOWN = 6;

function isFailed(e: TimelineItem): boolean {
  return e.status === 'error' || e.status === 'blocked';
}

/** Jump to an event in this session's transcript. */
function useFocusEvent(sessionId: string) {
  const store = useSessionStore();
  return (eventId: number | null) => {
    const base = sessionHref(sessionId, store);
    const next = eventId != null ? `${base}?e=${eventId}` : base;
    // Same link as the current one: no hashchange would fire, so announce it ourselves.
    if (window.location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else window.location.hash = next;
  };
}

/** A failed command and every retry of it. */
interface FailedGroup {
  key: string;
  events: TimelineItem[];
  /** Separate tries. Records of one call a few seconds apart are one attempt:
   *  some agents report a call twice. */
  attempts: number;
}

const SAME_ATTEMPT_MS = 5000;

/** Retries of the same failing command collapse into one row. */
function groupFailures(events: TimelineItem[]): FailedGroup[] {
  const groups = new Map<string, FailedGroup & { lastMs: number }>();
  for (const e of events) {
    const key = `${e.category}:${(e.target || e.title).replace(/\s+/g, ' ').trim()}`;
    const at = Date.parse(e.start_ts || e.ts);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { key, events: [e], attempts: 1, lastMs: at });
      continue;
    }
    g.events.push(e);
    if (!(Math.abs(at - g.lastMs) <= SAME_ATTEMPT_MS)) g.attempts++;
    g.lastMs = at;
  }
  return [...groups.values()];
}

function clock(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function InsightsTab({ detail }: InsightsTabProps) {
  const sessionId = detail.summary.id;
  const store = useSessionStore();
  const focusEvent = useFocusEvent(sessionId);
  const [findings, setFindings] = useState<ActionableInsight[] | null>(null);
  const [showAllFailed, setShowAllFailed] = useState(false);

  // One-shot fetch: the tab mounts lazily, so this doesn't touch the hot
  // session-detail polling path.
  useEffect(() => {
    let active = true;
    getSessionInsights(sessionId, store)
      .then((r) => active && setFindings(r.insights))
      .catch(() => active && setFindings([]));
    return () => {
      active = false;
    };
  }, [sessionId, store]);

  const sorted = useMemo(
    () => [...(findings ?? [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    [findings],
  );
  const failed = useMemo(() => parentTimelineItems(detail).filter(isFailed), [detail]);
  const failedGroups = useMemo(() => groupFailures(failed), [failed]);
  const failedCount = failedGroups.reduce((n, g) => n + g.attempts, 0);

  if (findings === null) return <FindingsSkeleton />;

  const clean = sorted.length === 0 && failedCount === 0;
  const worst = sorted[0]?.severity;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            clean ? 'bg-olive' : worst === 'critical' ? 'bg-alert' : worst === 'warn' || failedCount ? 'bg-amber' : 'bg-cobalt'
          }`}
          aria-hidden
        />
        <p className="text-small text-fg/80">
          {clean
            ? 'Nothing to fix in this session.'
            : [sorted.length && plural(sorted.length, 'finding'), failedCount && plural(failedCount, 'failed step')]
                .filter(Boolean)
                .join(' · ')}
        </p>
        <a href="#/findings" className="press ml-auto rounded-chip text-data text-fg/50 transition-colors duration-150 hover:text-fg">
          All findings
        </a>
      </div>

      {clean && (
        <div className="flex flex-col items-center gap-2 rounded-control border border-line/10 px-6 py-12 text-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-olive/[0.12] text-olive">
            <Icon name="check" size={16} stroke={2} />
          </span>
          <p className="text-small font-medium text-fg/80">Clean session</p>
          <p className="max-w-[44ch] text-data leading-relaxed text-fg/45">
            No rule flagged anything and every step succeeded.
          </p>
        </div>
      )}

      {sorted.length > 0 && (
        <ul className="divide-y divide-line/10 overflow-hidden rounded-control border border-line/10 bg-surface">
          {sorted.map((f) => (
            <FindingRow key={f.fingerprint} finding={f} onFocus={focusEvent} />
          ))}
        </ul>
      )}

      {failedCount > 0 && (
        <section className="space-y-2">
          <h3 className="font-mono text-label font-semibold uppercase tracking-label text-fg/45">
            Failed steps · {failedCount}
          </h3>
          <ul className="divide-y divide-line/[0.07] overflow-hidden rounded-control border border-line/10 bg-surface">
            {(showAllFailed ? failedGroups : failedGroups.slice(0, FAILED_SHOWN)).map((g) => (
              <FailedRow key={g.key} group={g} onFocus={focusEvent} />
            ))}
          </ul>
          {failedGroups.length > FAILED_SHOWN && (
            <button
              type="button"
              onClick={() => setShowAllFailed((v) => !v)}
              className="btn-ghost focus-ring h-7 px-2 text-data"
            >
              {showAllFailed ? 'Show fewer' : `Show all ${failedGroups.length}`}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function FindingRow({ finding: f, onFocus }: { finding: ActionableInsight; onFocus: (eventId: number | null) => void }) {
  return (
    <li className="space-y-3 px-5 py-4">
      <div className="flex items-start gap-3">
        <span className={`chip mt-px shrink-0 ${TONE[f.severity]}`}>{f.severity}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-small font-medium leading-snug text-fg">{f.title}</p>
          <p className="break-words text-data leading-relaxed text-fg/55">{f.detail}</p>
        </div>
        <a
          href={`#/findings?pillar=${f.pillar}&f=${encodeURIComponent(f.fingerprint)}`}
          className="press focus-ring shrink-0 rounded-chip text-data text-fg/45 transition-colors duration-150 hover:text-fg"
          title="Open in Findings to resolve or dismiss"
        >
          Manage
        </a>
      </div>

      <div className="flex gap-2.5 rounded-control bg-panel px-3 py-2.5">
        <span className="shrink-0 font-mono text-label font-semibold uppercase tracking-label text-hot">Fix</span>
        <p className="text-data leading-relaxed text-fg/80">{f.recommendation}</p>
      </div>

      {f.evidence.length > 0 && (
        <ul className="-mx-2 space-y-px">
          {f.evidence.map((ev, i) => (
            <li key={`${ev.event_id ?? 'x'}-${i}`}>
              <button
                type="button"
                onClick={() => onFocus(ev.event_id)}
                disabled={ev.event_id == null}
                title={ev.label}
                className="group focus-ring flex h-7 w-full items-center gap-2 rounded-chip px-2 text-left transition-colors duration-150 hover:bg-fg/[0.04] disabled:pointer-events-none"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-data text-fg/60">{ev.label}</span>
                {ev.value && <span className="shrink-0 font-mono text-data tabular-nums text-fg/45">{ev.value}</span>}
                {ev.event_id != null && (
                  <Icon name="arrow" size={12} className="shrink-0 text-fg/30 transition-colors duration-150 group-hover:text-fg/70" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function FailedRow({ group, onFocus }: { group: FailedGroup; onFocus: (eventId: number | null) => void }) {
  const e = group.events[0];
  const n = group.attempts;
  const target = (e.target || e.title).replace(/\s+/g, ' ').trim();
  return (
    <li>
      <button
        type="button"
        onClick={() => onFocus(e.id)}
        title={target}
        className="group focus-ring flex h-9 w-full items-center gap-3 px-4 text-left transition-colors duration-150 hover:bg-fg/[0.03]"
      >
        <Icon name={CATEGORY_ICON[e.category] ?? 'file'} size={13} className="shrink-0 text-fg/40" />
        <span className="w-20 shrink-0 truncate font-mono text-data text-fg/80">{stepName(e).label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-data text-fg/50">{target}</span>
        {e.status === 'blocked' && <span className={`chip shrink-0 ${TONE.warn}`}>blocked</span>}
        {n > 1 && (
          <span className="shrink-0 font-mono text-label tabular-nums text-fg/45" title={`Failed ${n} times`}>
            ×{n}
          </span>
        )}
        <span className="w-16 shrink-0 text-right font-mono text-label tabular-nums text-fg/35" title={formatDateTime(e.start_ts || e.ts)}>
          {clock(e.start_ts || e.ts)}
        </span>
        <Icon name="arrow" size={12} className="shrink-0 text-fg/25 transition-colors duration-150 group-hover:text-fg/70" />
      </button>
    </li>
  );
}

function FindingsSkeleton() {
  return (
    <div className="space-y-6 motion-safe:animate-pulse" aria-label="Loading findings">
      <div className="h-4 w-48 rounded-chip bg-fg/[0.06]" />
      <div className="space-y-3 rounded-control border border-line/10 px-5 py-4">
        <div className="h-4 w-2/3 rounded-chip bg-fg/[0.06]" />
        <div className="h-3 w-full rounded-chip bg-fg/[0.04]" />
        <div className="h-10 w-full rounded-control bg-fg/[0.04]" />
      </div>
    </div>
  );
}
