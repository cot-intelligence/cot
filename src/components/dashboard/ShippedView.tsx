import { useMemo, useState } from 'react';
import { getShipped, type ShippedItem, type ShippedKind, type ShippedList } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { fmt } from '../forest/format';
import { Icon, type IconName } from '../forest/icons';
import { Seg } from '../forest/ui';

const WINDOWS = [
  { k: 7, l: '7d' },
  { k: 30, l: '30d' },
  { k: 90, l: '90d' },
  { k: 0, l: 'all' },
];

export const SHIPPED_KIND: Record<ShippedKind, { label: string; plural: string; icon: IconName; color: string }> = {
  pr: { label: 'Pull request', plural: 'Pull requests', icon: 'branch', color: 'var(--v-cobalt)' },
  merge: { label: 'Merge', plural: 'Merges', icon: 'check', color: 'var(--v-olive)' },
  commit: { label: 'Commit', plural: 'Commits', icon: 'file', color: 'var(--v-hot)' },
  push: { label: 'Push', plural: 'Pushes', icon: 'upload', color: 'var(--v-faint)' },
};
const KIND_ORDER: ShippedKind[] = ['pr', 'merge', 'commit', 'push'];

function host(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h === 'github.com' ? 'GitHub' : h.startsWith('gitlab.') ? 'GitLab' : h;
  } catch {
    return 'Open';
  }
}

function fallbackTitle(it: ShippedItem): string {
  if (it.kind === 'pr') return it.number ? `Pull request #${it.number}` : 'Pull request';
  if (it.kind === 'merge') return it.number ? `Merged #${it.number}` : 'Merged a pull request';
  if (it.kind === 'push') return it.branch ? `Pushed ${it.branch}` : 'Pushed';
  return it.sha ? `Commit ${it.sha.slice(0, 7)}` : 'Commit';
}

/** One shipped thing: what it was, where, and a way to see it (the PR or commit, else the call in its session). */
export function ShippedRow({ it, now, onSelect, showProject = true, index = 0 }: {
  it: ShippedItem;
  now: string;
  onSelect: (sessionId: string, eventId?: number) => void;
  showProject?: boolean;
  index?: number;
}) {
  const k = SHIPPED_KIND[it.kind];
  const open = () => onSelect(it.session_id, it.event_id ?? undefined);
  const title = it.kind === 'push' ? fallbackTitle(it) : it.title || fallbackTitle(it);
  const meta = [
    showProject ? it.project_name : null,
    it.number && it.kind !== 'push' ? `#${it.number}` : null,
    it.sha ? it.sha.slice(0, 7) : null,
    it.kind === 'pr' && it.branch ? `${it.branch}${it.base ? ` → ${it.base}` : ''}` : it.kind === 'commit' ? it.branch : null,
    it.range ?? null,
  ].filter(Boolean);
  return (
    <li className="sh-row rise" style={{ ['--i' as string]: index }}>
      <button type="button" className="sh-main" onClick={open} title="Open the session where this happened">
        <span className="sh-ic" style={{ color: k.color }} aria-label={k.label}><Icon name={k.icon} size={14} /></span>
        <span className="sh-txt">
          <b>{title}</b>
          <span className="mono">
            {meta.join(' · ')}
            {(it.added || it.removed) ? <> {meta.length > 0 && '· '}<span className="d-add">+{fmt.k(it.added ?? 0)}</span> <span className="d-rm">−{fmt.k(it.removed ?? 0)}</span></> : null}
          </span>
        </span>
        <span className="sh-when mono">{fmt.ago(it.ts, now)}</span>
      </button>
      {it.url ? (
        <a className="vbtn vbtn-quiet vbtn-sm" href={it.url} target="_blank" rel="noreferrer noopener" title={it.url}>
          {host(it.url)}<Icon name="external" size={13} />
        </a>
      ) : (
        <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={open} title="No link was printed; open the call that did it">
          Seen in session<Icon name="arrow" size={13} />
        </button>
      )}
    </li>
  );
}

/**
 * Activity → Shipped: every pull request, merge, commit and push agents made,
 * with its link when the command's output named one and always the call that did it.
 */
export function ShippedView({ onSelect, initialProject }: { onSelect: (sessionId: string, eventId?: number) => void; initialProject?: string }) {
  const [days, setDays] = useState(30);
  // #/metrics-history?tab=shipped&kind=pr opens on one kind (the Overview's Outcomes rows).
  const [kind, setKind] = useState<ShippedKind | null>(() => {
    const k = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('kind');
    return k && k in SHIPPED_KIND ? (k as ShippedKind) : null;
  });
  const [project, setProject] = useState<string | null>(initialProject ?? null);
  const { data, error } = usePolling<ShippedList>(['shipped', days], () => getShipped(days), 60000);
  const projects = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of data?.items ?? []) m.set(it.project_name ?? 'no project', (m.get(it.project_name ?? 'no project') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);
  const inProject = useMemo(() => (data?.items ?? []).filter((it) => project === null || (it.project_name ?? 'no project') === project), [data, project]);
  const counts = useMemo(() => {
    const c: Record<ShippedKind, number> = { pr: 0, merge: 0, commit: 0, push: 0 };
    for (const it of inProject) c[it.kind] += 1;
    return c;
  }, [inProject]);
  const items = inProject.filter((it) => kind === null || it.kind === kind);
  const shown = items.slice(0, 300);
  const now = new Date().toISOString();

  return (
    <div className="scroll">
      <div className="page">
        <div className="ph">
          <div>
            <span className="label">Activity</span>
            <h1>Shipped</h1>
            <p>Pull requests, merges, commits and pushes agents made. Each opens on GitHub when a link was printed, or on the call that did it.</p>
          </div>
          <Seg id="sh-range" value={days} options={WINDOWS} onChange={setDays} />
        </div>

        <div className="kpis">
          {KIND_ORDER.map((k) => (
            <button key={k} type="button" className="kpi sh-kpi" aria-pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>
              <span className="label">{SHIPPED_KIND[k].plural}</span>
              {data ? <span className="v">{fmt.n(counts[k])}</span> : <span className="sk" style={{ height: 34, width: 64 }} />}
              <span className="d">{kind === k ? 'showing only these · click to clear' : 'click to filter'}</span>
            </button>
          ))}
        </div>

        {error ? (
          <section className="card" style={{ marginTop: 16 }}>
            <div className="oc-empty"><b>Couldn't load what shipped</b><p>The collector didn't answer. It may be restarting; this retries on its own.</p></div>
          </section>
        ) : (
          <div className="oc-split-r">
            <section className="card" aria-labelledby="sh-proj" style={{ alignSelf: 'start' }}>
              <div className="card-h"><span className="card-t" id="sh-proj">Projects</span></div>
              <div className="card-b" style={{ paddingTop: 0 }}>
                {!data ? (
                  <div style={{ display: 'grid', gap: 8 }}>{[0, 1, 2, 3].map((i) => <span key={i} className="sk" style={{ height: 30 }} />)}</div>
                ) : (
                  <div className="oc-legend" style={{ gridTemplateColumns: '1fr', marginTop: 0 }}>
                    <button type="button" aria-pressed={project === null} onClick={() => setProject(null)}>
                      <i style={{ background: 'var(--v-hot)' }} /><span>All projects</span><span className="num-t dim">{fmt.n(data.items.length)}</span>
                    </button>
                    {projects.map(([name, n]) => (
                      <button key={name} type="button" aria-pressed={project === name} onClick={() => setProject(project === name ? null : name)}>
                        <i style={{ background: 'var(--v-mute)' }} /><span className="truncate">{name}</span><span className="num-t dim">{fmt.n(n)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="card" aria-labelledby="sh-list" style={{ overflow: 'hidden' }}>
              <div className="card-h">
                <span className="card-t" id="sh-list">{kind ? SHIPPED_KIND[kind].plural : 'Everything'}{project ? ` in ${project}` : ''}</span>
                <span className="label">{fmt.n(items.length)}{items.length > shown.length ? ` · newest ${shown.length}` : ''}</span>
              </div>
              {!data ? (
                <div className="card-b" style={{ display: 'grid', gap: 10 }}>{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className="sk" style={{ height: 40 }} />)}</div>
              ) : shown.length === 0 ? (
                <div className="oc-empty">
                  <b>Nothing shipped {days ? `in the last ${days} days` : 'yet'}</b>
                  <p>This fills in when an agent runs <code className="mono">git commit</code>, <code className="mono">git push</code>, <code className="mono">gh pr create</code> or <code className="mono">gh pr merge</code>.</p>
                </div>
              ) : (
                <ul className="sh-list">
                  {shown.map((it, i) => <ShippedRow key={`${it.kind}:${it.event_id ?? it.sha}:${i}`} it={it} now={now} onSelect={onSelect} showProject={project === null} index={i} />)}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
