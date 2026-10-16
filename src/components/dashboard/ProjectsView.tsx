import { useMemo, useState } from 'react';
import { getInsights, getProjects, getSessionsPage, type InsightsResponse, type ProjectListItem, type SessionSummary } from '../../lib/api';
import { getPrefs } from '../../lib/prefs';
import { sourceLabel } from '../../lib/sourceLabels';
import { usePolling } from '../../lib/usePolling';
import { StackBar } from '../forest/charts';
import { fmt, project as fproject } from '../forest/format';
import { Icon } from '../forest/icons';
import { agentColor, Seg } from '../forest/ui';

const WINDOWS = [
  { k: 1, l: '1d' },
  { k: 7, l: '7d' },
  { k: 30, l: '30d' },
  { k: 90, l: '90d' },
  { k: 0, l: 'all' },
];

type SortKey = 'recent' | 'name' | 'sessions' | 'cost';
const SORTS: { k: SortKey; l: string }[] = [
  { k: 'name', l: 'Project' },
  { k: 'sessions', l: 'Sessions' },
  { k: 'cost', l: 'Spend' },
  { k: 'recent', l: 'Last active' },
];

function windowText(days: number): string {
  if (!days) return 'All time';
  return days === 1 ? 'Last 24 hours' : `Last ${days} days`;
}

const projectHref = (name: string) => `#/project/${encodeURIComponent(name)}`;

/**
 * Every project the agents worked in, with its totals in the window and what its
 * folder looks like on disk: the git branch and remote, whether it is a worktree,
 * the last commit, and the stacks it uses.
 */
export function ProjectsView() {
  const [days, setDays] = useState<number>(() => getPrefs().range);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const { data, error } = usePolling(['projects', days], () => getProjects(days), 60000);
  // Same window key the Overview and Findings use, so the shared result is reused.
  const { data: ins } = usePolling<InsightsResponse>(['insights', days], () => getInsights(days, 'all'), 60000);
  const active = useMemo(() => (ins?.insights ?? []).filter((f) => f.status === 'active'), [ins]);
  // Findings per project: only the sessions findings cite need their project.
  const evidenceIds = useMemo(() => [...new Set(active.flatMap((f) => f.evidence.map((e) => e.session_id)))].sort().slice(0, 500), [active]);
  const { data: evidenceSessions } = usePolling<SessionSummary[]>(
    ['sessions', 'overview-evidence', evidenceIds.join(',')],
    () => (evidenceIds.length ? getSessionsPage({ ids: evidenceIds, limit: 500 }).then((p) => p.sessions) : Promise.resolve([])),
    60000,
  );
  const findings = useMemo(() => {
    if (!ins || !evidenceSessions) return null;
    const projectOf = new Map(evidenceSessions.map((s) => [s.id, fproject(s.cwd)]));
    const out = new Map<string, { n: number; critical: boolean }>();
    for (const f of active) {
      for (const name of new Set(f.evidence.map((e) => projectOf.get(e.session_id)).filter(Boolean) as string[])) {
        const x = out.get(name) ?? { n: 0, critical: false };
        x.n += 1;
        x.critical ||= f.severity === 'critical';
        out.set(name, x);
      }
    }
    return out;
  }, [ins, evidenceSessions, active]);

  const projects = data?.projects;
  const rows = useMemo(() => {
    if (!projects) return [];
    const needle = q.trim().toLowerCase();
    const hit = (p: ProjectListItem) =>
      !needle ||
      [p.name, ...p.paths, p.location.git?.remote, p.location.git?.branch, ...(p.location.stacks ?? [])]
        .some((s) => s?.toLowerCase().includes(needle));
    const by: Record<SortKey, (a: ProjectListItem, b: ProjectListItem) => number> = {
      recent: (a, b) => (b.last_active ?? '').localeCompare(a.last_active ?? ''),
      name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      sessions: (a, b) => b.sessions - a.sessions,
      cost: (a, b) => b.cost - a.cost,
    };
    return projects.filter(hit).sort(by[sort]);
  }, [projects, q, sort]);

  if (error && !data) {
    return (
      <div className="scroll" id="vf-scroll">
        <div className="page"><div className="card empty">The collector didn't answer, so projects can't be listed. It retries on its own.</div></div>
      </div>
    );
  }

  const all = projects ?? [];
  const repos = all.filter((p) => p.location.git).length;
  const missing = all.filter((p) => p.location.exists === false).length;
  const sources = [...new Set(all.flatMap((p) => Object.keys(p.agents)))].sort();
  const now = new Date().toISOString();

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div style={{ minWidth: 0 }}>
            <span className="label">Workspace</span>
            <h1>Projects</h1>
            <p>
              {windowText(days)} · {projects ? `${all.length} project${all.length === 1 ? '' : 's'}` : '…'}
              {projects && all.length > 0 && ` · ${repos} git repo${repos === 1 ? '' : 's'}`}
              {missing > 0 && ` · ${missing} not on this machine`}
            </p>
          </div>
          <Seg id="projects-range" value={days} options={WINDOWS} onChange={setDays} label="Window" />
        </div>

        <section className="card proj-rise" aria-label="Projects" style={{ overflow: 'hidden' }}>
          <div className="card-h" style={{ paddingBottom: 12, gap: 12, flexWrap: 'wrap' }}>
            <label className="vfield">
              <Icon name="search" size={15} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, path, remote or branch" aria-label="Search projects" />
            </label>
            {sources.length > 0 && (
              <span style={{ display: 'flex', gap: 14, fontSize: 12 }} className="dim">
                {sources.map((a) => <span key={a} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: 2, background: agentColor(a) }} />{sourceLabel(a)}</span>)}
              </span>
            )}
          </div>
          {!projects ? (
            <div className="card-b" aria-busy="true" style={{ display: 'grid', gap: 10 }}>
              {[0, 1, 2, 3, 4].map((i) => <span key={i} className="sk" style={{ display: 'block', height: 40 }} />)}
            </div>
          ) : rows.length === 0 ? (
            <div className="card-b dim" style={{ fontSize: 13 }}>
              {all.length === 0 ? (
                <>No sessions {days ? `in the ${windowText(days).toLowerCase()}` : 'yet'}.{days !== 0 && <> <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => setDays(0)}>Show all time</button></>}</>
              ) : (
                <>No project matches “{q}”.</>
              )}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="t">
                <thead>
                  <tr>
                    <SortTh k="name" sort={sort} onSort={setSort} />
                    <th>Repository</th>
                    <th>Stack</th>
                    <th>Agents</th>
                    <SortTh k="sessions" sort={sort} onSort={setSort} num />
                    <SortTh k="cost" sort={sort} onSort={setSort} num />
                    <th className="num">Findings</th>
                    <SortTh k="recent" sort={sort} onSort={setSort} num />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const git = p.location.git;
                    const fx = findings?.get(p.name);
                    return (
                      <tr key={p.name} className="click" onClick={() => { window.location.hash = projectHref(p.name); }}>
                        <td style={{ maxWidth: 280 }}>
                          <a href={projectHref(p.name)} onClick={(e) => e.stopPropagation()} className="mono proj-link" style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</a>
                          <div className="mono faint truncate" style={{ fontSize: 11, marginTop: 2 }} title={p.paths.join('\n')}>
                            {p.paths[0]}{p.paths.length > 1 ? ` +${p.paths.length - 1}` : ''}
                          </div>
                        </td>
                        <td style={{ minWidth: 200, maxWidth: 280, whiteSpace: 'nowrap' }}>
                          {p.location.exists === null ? (
                            <span className="faint" style={{ fontSize: 12 }} title="macOS asks before an app reads Desktop, Documents or Downloads, so cot leaves these folders alone.">Protected folder</span>
                          ) : !p.location.exists ? (
                            <span className="faint" style={{ fontSize: 12 }}>Not on this machine</span>
                          ) : !git ? (
                            <span className="faint" style={{ fontSize: 12 }}>Not a git repo</span>
                          ) : (
                            <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                              <span className="mono truncate" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }} title={git.last_commit ? `Last commit: ${git.last_commit.subject}` : undefined}>
                                <Icon name="branch" size={13} />
                                <span className="truncate">{git.branch ?? (git.detached ? `detached ${git.detached}` : 'no branch')}</span>
                              </span>
                              <span className="mono faint truncate" style={{ fontSize: 11 }} title={git.remote ?? 'No remote'}>
                                {git.worktree_of ? `worktree of ${git.worktree_of}` : git.remote ?? 'no remote'}
                                {git.last_commit && ` · committed ${fmt.ago(new Date(git.last_commit.at * 1000).toISOString(), now)}`}
                              </span>
                            </div>
                          )}
                        </td>
                        <td>
                          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', minWidth: 90 }}>
                            {(p.location.stacks ?? []).slice(0, 3).map((s) => <span key={s} className="vchip c-dim">{s}</span>)}
                            {!p.location.stacks?.length && <span className="faint">—</span>}
                          </span>
                        </td>
                        <td style={{ minWidth: 110 }} title={Object.entries(p.agents).map(([a, n]) => `${sourceLabel(a)}: ${n}`).join('\n')}>
                          <StackBar parts={sources.map((a) => ({ key: a, value: p.agents[a] ?? 0, color: agentColor(a) }))} />
                        </td>
                        <td className="num">
                          {fmt.n(p.sessions)}
                          {p.active > 0 && <div style={{ color: 'var(--v-olive)', fontSize: 11 }}>{p.active} live</div>}
                        </td>
                        <td className="num">{fmt.usd(p.cost)}</td>
                        <td className="num">{!findings ? '…' : fx ? <span style={fx.critical ? { color: 'var(--v-alert)' } : undefined}>{fx.n}</span> : 0}</td>
                        <td className="num dim" style={{ whiteSpace: 'nowrap' }}>{p.last_active ? fmt.ago(p.last_active, now) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SortTh({ k, sort, onSort, num }: { k: SortKey; sort: SortKey; onSort: (k: SortKey) => void; num?: boolean }) {
  const on = sort === k;
  return (
    <th className={num ? 'num' : undefined} aria-sort={on ? (k === 'name' ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => onSort(k)} style={on ? { color: 'var(--v-fg)' } : undefined}>
        {SORTS.find((s) => s.k === k)!.l}
        {on && <Icon name="down" size={12} style={k === 'name' ? { transform: 'rotate(180deg)' } : undefined} />}
      </button>
    </th>
  );
}
