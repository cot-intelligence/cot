import { useState } from 'react';
import type { ActionableInsight, InsightSeverity, InsightStatus } from '../../lib/api';
import { formatRelative } from '../../lib/categoryMeta';
import { Icon } from '../ui/icons';
import { TONE } from '../ui/tone';

export function SeverityBadge({ severity }: { severity: InsightSeverity }) {
  return (
    <span className={`chip shrink-0 ${TONE[severity]}`}>
      {severity}
    </span>
  );
}

export interface FindingGroupData {
  id: string;
  title: string;
  items: ActionableInsight[];
}

/** Collapse findings of the same rule type into one group (already severity-sorted). */
export function groupByRule(findings: ActionableInsight[]): FindingGroupData[] {
  const map = new Map<string, ActionableInsight[]>();
  for (const f of findings) {
    const arr = map.get(f.id);
    if (arr) arr.push(f);
    else map.set(f.id, [f]);
  }
  return [...map.entries()].map(([id, items]) => ({
    id,
    title: items[0].group_title,
    items,
  }));
}

export function FindingGroup({
  group,
  view,
  onSelect,
  onLifecycle,
}: {
  group: FindingGroupData;
  view: InsightStatus;
  onSelect: (id: string, eventId?: number) => void;
  onLifecycle: (fingerprint: string, action: 'dismiss' | 'restore') => void;
}) {
  const [open, setOpen] = useState(false);
  // Items are severity-sorted, so the first item carries the group's max severity.
  const severity = group.items[0].severity;
  return (
    <div className="min-w-0 bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
        title={open ? 'Collapse group' : 'Expand group'}>
        <SeverityBadge severity={severity} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-fg transition-colors hover:text-hot">
          {group.title}
        </span>
        <span className="shrink-0 border rounded-chip border-line/[0.16] px-1.5 py-0.5 font-mono text-label font-semibold tabular-nums text-fg/60">
          {group.items.length}
        </span>
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          className="h-3 w-3 shrink-0 text-fg/40"
        />
      </button>
      {open && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-px border-t border-line/10 bg-fg/10">
          {group.items.map((f) => (
            <FindingCard
              key={f.fingerprint}
              finding={f}
              view={view}
              onSelect={onSelect}
              onLifecycle={onLifecycle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FindingCard({
  finding,
  view,
  onSelect,
  onLifecycle,
}: {
  finding: ActionableInsight;
  view: InsightStatus;
  onSelect: (id: string, eventId?: number) => void;
  onLifecycle: (fingerprint: string, action: 'dismiss' | 'restore') => void;
}) {
  const compact = finding.tier === 2;
  const [expanded, setExpanded] = useState(!compact);
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <div className="flex items-start gap-2.5">
        <SeverityBadge severity={finding.severity} />
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="min-w-0 flex-1 text-left"
          title={expanded ? 'Collapse' : 'Expand'}>
          <p className="font-mono text-xs font-semibold text-fg transition-colors hover:text-hot">
            {finding.title}
          </p>
          {view === 'resolved' && finding.resolved_at && (
            <p className="mt-0.5 font-mono text-label uppercase tracking-label text-olive">
              <Icon name="check" className="mr-1 inline h-2.5 w-2.5" />
              fixed {formatRelative(finding.resolved_at)}
            </p>
          )}
        </button>
        {finding.first_seen && view === 'active' && (
          <span className="hidden shrink-0 font-mono text-label text-fg/40 sm:inline">
            since {formatRelative(finding.first_seen)}
          </span>
        )}
        {view !== 'resolved' && (
          <button
            type="button"
            onClick={() => onLifecycle(finding.fingerprint, view === 'dismissed' ? 'restore' : 'dismiss')}
            title={view === 'dismissed' ? 'Restore this finding' : 'Dismiss this finding'}
            className="shrink-0 border rounded-chip border-line/[0.16] px-1.5 py-0.5 font-mono text-label font-semibold uppercase tracking-label text-fg/60 transition-colors hover:border-line/25 hover:text-fg focus-visible:border-hot focus-visible:outline-none">
            {view === 'dismissed' ? 'Restore' : '×'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-2 space-y-2 pl-0.5">
          <p className="break-words font-mono text-data leading-relaxed text-fg/70">
            {finding.detail}
          </p>
          <p className="rounded-cell bg-hot/[0.06] px-3 py-2 font-mono text-data font-semibold leading-relaxed text-fg/85">
            {finding.recommendation}
          </p>
          {finding.evidence.length > 0 && (
            <ul className="space-y-0.5 pt-0.5">
              {finding.evidence.map((ev, i) => (
                <li key={`${ev.session_id}-${ev.event_id ?? i}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(ev.session_id, ev.event_id ?? undefined)}
                    className="group flex w-full items-center gap-2 text-left">
                    <Icon
                      name="chevron-right"
                      className="h-2.5 w-2.5 shrink-0 text-fg/40 transition-colors group-hover:text-hot"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-label text-fg/60 transition-colors group-hover:text-hot">
                      {ev.label}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 font-mono text-label text-fg/40">
                      {ev.value && <span>{ev.value}</span>}
                      <span>{ev.session_id.slice(0, 8)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Pillar-scoped strip of findings for the unified Overview page. */
export function InsightStrip({
  findings,
  view,
  onSelect,
  onLifecycle,
}: {
  findings: ActionableInsight[];
  view: InsightStatus;
  onSelect: (id: string, eventId?: number) => void;
  onLifecycle: (fingerprint: string, action: 'dismiss' | 'restore') => void;
}) {
  const groups = groupByRule(findings);
  if (!groups.length) {
    return (
      <p className="font-mono text-xs text-olive">
        {view === 'active' ? 'No findings — clean.' : `Nothing ${view}.`}
      </p>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-px bg-line/10">
      {groups.map((g) =>
        g.items.length === 1 ? (
          <FindingCard
            key={g.items[0].fingerprint}
            finding={g.items[0]}
            view={view}
            onSelect={onSelect}
            onLifecycle={onLifecycle}
          />
        ) : (
          <FindingGroup key={g.id} group={g} view={view} onSelect={onSelect} onLifecycle={onLifecycle} />
        ),
      )}
    </div>
  );
}
