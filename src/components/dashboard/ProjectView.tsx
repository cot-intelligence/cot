import { useMemo, useState } from 'react';
import { getInsights, getProject, type InsightsResponse, type ProjectOverview } from '../../lib/api';
import { getPrefs } from '../../lib/prefs';
import { sessionHref } from '../../lib/sessionStore';
import { useHoverPrefetch } from '../../lib/sessionDetailQuery';
import { sourceLabel } from '../../lib/sourceLabels';
import { usePolling } from '../../lib/usePolling';
import { Columns, ShareBars, Sparkline } from '../forest/charts';
import { categoryLabel, fmt, modelLabel } from '../forest/format';
import { CATEGORY_ICON, Icon } from '../forest/icons';
import { Agent, agentColor, Seg, Sev } from '../forest/ui';

const WINDOWS = [
  { k: 1, l: '1d' },
  { k: 7, l: '7d' },
  { k: 30, l: '30d' },
  { k: 90, l: '90d' },
  { k: 0, l: 'all' },
];
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function windowText(days: number): string {
  if (!days) return 'All time';
  return days === 1 ? 'Last 24 hours' : `Last ${days} days`;
}

function hourLabel(key: string): string {
  return new Date(`${key}:00:00Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** One point per day (per hour for 24 hours) across the window, empty ones included. */
function filledSeries(p: ProjectOverview, days: number) {
  const now = Date.now();
  const hourly = days === 1;
  const step = hourly ? HOUR_MS : DAY_MS;
  const oldest = p.first_seen ? new Date(p.first_seen).getTime() : now;
  const n = hourly ? 24 : Math.min(days || Math.max(1, Math.ceil((now - oldest) / DAY_MS)), 120);
  const at = new Map(p.series.map((x) => [x.day, x]));
  return Array.from({ length: n }, (_, i) => {
    const key = new Date(now - (n - 1 - i) * step).toISOString().slice(0, hourly ? 13 : 10);
    const x = at.get(key);
    return { key, cost: x?.cost ?? 0, sessions: x?.sessions ?? 0, tools: x?.tools ?? 0 };
  });
}

/**
 * Everything one project's agents did: spend over time, which agents and models
 * did the work, what kind of work it was, its open findings and recent sessions.
 * A project is the last segment of the working directory, as everywhere else.
 */
export function ProjectView({ name, onSelect }: { name: string; onSelect: (id: string) => void }) {
  const [days, setDays] = useState<number>(() => getPrefs().range);
  const { data: p, error } = usePolling<ProjectOverview>(['project', name, days], () => getProject(name, days), 60000);
  // Same window key the Overview and Findings use, so the shared result is reused.
  const { data: ins } = usePolling<InsightsResponse>(['insights', days], () => getInsights(days, 'all'), 60000);
  const hoverPrefetch = useHoverPrefetch();

  const findings = useMemo(() => {
    if (!p || !ins) return null;
    const ids = new Set(p.session_ids);
    const rank = { critical: 0, warn: 1, info: 2 } as const;
    return ins.insights
      .filter((f) => f.status === 'active' && f.evidence.some((e) => ids.has(e.session_id)))
      .sort((a, b) => rank[a.severity] - rank[b.severity]);
  }, [p, ins]);

  if (error && !p) {
    return (
      <div className="scroll" id="vf-scroll">
        <div className="page"><div className="card empty">The collector didn't answer, so this project can't be shown. It retries on its own.</div></div>
      </div>
    );
  }
  if (!p) return <ProjectSkeleton name={name} />;

  const series = filledSeries(p, days);
  const criticals = findings?.filter((f) => f.severity === 'critical').length ?? 0;
  const cats = Object.entries(p.categories).slice(0, 7);
  const kpis = [
    { k: 'Sessions', v: fmt.n(p.sessions), note: p.active ? `${p.active} live now` : 'none live', spark: series.map((x) => x.sessions) },
    { k: 'Spend', v: fmt.usd(p.cost), note: p.sessions ? `${fmt.usd(p.cost / p.sessions)} a session` : 'list price', spark: series.map((x) => x.cost) },
    { k: 'Tool calls', v: fmt.n(p.tools), note: `${fmt.n(p.events)} events`, spark: series.map((x) => x.tools) },
    { k: 'Open findings', v: findings ? fmt.n(findings.length) : '…', note: findings ? (criticals ? `${criticals} critical` : 'none critical') : 'computing…' },
  ];

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page proj">
        <a href="#/projects" className="vbtn vbtn-ghost vbtn-sm" style={{ marginLeft: -10, marginBottom: 8 }}><Icon name="back" size={14} />Projects</a>
        <div className="ph">
          <div style={{ minWidth: 0 }}>
            <span className="label">Project</span>
            <h1 style={{ overflowWrap: 'anywhere' }}>{p.name}</h1>
            <p>
              {windowText(days)} · {p.agents.length} agent{p.agents.length === 1 ? '' : 's'}
              {p.last_active ? ` · last active ${fmt.ago(p.last_active, new Date().toISOString())}` : ''}
            </p>
            {p.paths.length > 0 && (
              <p className="mono faint truncate" style={{ fontSize: 12, marginTop: 4 }} title={p.paths.join('\n')}>
                {p.paths[0]}{p.paths.length > 1 ? ` and ${p.paths.length - 1} more` : ''}
              </p>
            )}
          </div>
          <Seg id="proj-range" value={days} options={WINDOWS} onChange={setDays} label="Window" />
        </div>

        {p.sessions === 0 ? (
          <div className="card empty proj-rise">
            No sessions in {p.name} {days ? `in the ${windowText(days).toLowerCase()}` : 'yet'}.
            {days !== 0 && <> <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => setDays(0)}>Show all time</button></>}
          </div>
        ) : (
          <>
            <div className="kpis proj-rise">
              {kpis.map((k) => (
                <div className="kpi" key={k.k}>
                  <span className="label">{k.k}</span>
                  <span className="v">{k.v}</span>
                  <span className="d"><span className="truncate">{k.note}</span>{k.spark && <span style={{ color: 'var(--v-hot)' }}><Sparkline values={k.spark} width={72} height={20} /></span>}</span>
                </div>
              ))}
            </div>

            {/* Row one stretches: the chart card matches the breakdown beside it. */}
            <div className="proj-grid proj-rise" style={{ ['--i' as string]: 1, alignItems: 'stretch' }}>
              <section className="card" aria-labelledby="proj-spend" style={{ display: 'flex', flexDirection: 'column' }}>
                <div className="card-h"><span className="card-t" id="proj-spend">{days === 1 ? 'Hourly spend' : 'Daily spend'}</span><span className="mono faint" style={{ fontSize: 12 }}>{fmt.usd(p.cost)} total</span></div>
                <div className="card-b" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                  <Columns key={days} data={series.map((x) => ({ key: x.key, value: x.cost }))} color="var(--v-hot)" muted="var(--v-mute)" label={days === 1 ? hourLabel : fmt.day} format={fmt.usd} height={220} />
                </div>
              </section>
              <section className="card" aria-labelledby="proj-agents">
                <div className="card-h"><span className="card-t" id="proj-agents">Who did the work</span><span className="label">by spend</span></div>
                <div className="card-b" style={{ display: 'grid', gap: 18 }}>
                  <ShareBars
                    rows={p.agents.map((a) => ({ key: a.source, label: <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Agent id={a.source} /><span className="faint mono" style={{ fontSize: 11 }}>{a.sessions}</span></span>, value: a.cost, color: agentColor(a.source) }))}
                    track="var(--v-panel)"
                    format={fmt.usd}
                  />
                  {p.models.length > 0 && (
                    <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--v-line)', paddingTop: 14 }}>
                      <span className="label">Models</span>
                      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                        {p.models.slice(0, 5).map((m) => (
                          <li key={m.model} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                            <span className="mono truncate">{modelLabel(m.model)}</span>
                            <span className="mono dim">{m.cost == null ? `${fmt.k(m.tokens)} tok` : fmt.usd(m.cost)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </section>
            </div>

            <div className="proj-grid proj-rise" style={{ ['--i' as string]: 2 }}>
              <section className="card" aria-labelledby="proj-recent" style={{ overflow: 'hidden' }}>
                <div className="card-h"><span className="card-t" id="proj-recent">Recent sessions</span><span className="label">{fmt.n(p.sessions)} in window</span></div>
                <ul style={{ listStyle: 'none', margin: 0, padding: '0 8px 8px' }}>
                  {p.recent.map((s) => (
                    <li key={s.id}>
                      <a
                        href={sessionHref(s.id)}
                        onClick={(e) => { e.preventDefault(); onSelect(s.id); }}
                        onPointerEnter={() => hoverPrefetch.start(s.id)}
                        onPointerLeave={hoverPrefetch.cancel}
                        onFocus={() => hoverPrefetch.start(s.id)}
                        className="hov proj-row">
                        <span style={{ minWidth: 0, display: 'grid', gap: 2 }}>
                          <span className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>{s.title || 'Untitled session'}</span>
                          <span className="faint" style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                            {s.status === 'active' && <span className="vchip c-ok"><span className="dot" />live</span>}
                            {sourceLabel(s.source)} · {fmt.ago(s.last_activity ?? s.started_at, new Date().toISOString())}
                          </span>
                        </span>
                        <span className="mono dim" style={{ fontSize: 12, textAlign: 'right' }}>{s.has_cost ? fmt.usd(s.cost_usd) : '—'}<br /><span className="faint">{fmt.n(s.tool_count)} tools</span></span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
              <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
                <section className="card" aria-labelledby="proj-findings">
                  <div className="card-h"><span className="card-t" id="proj-findings">Open findings</span><a href="#/findings" className="vbtn vbtn-ghost vbtn-sm">All <Icon name="arrow" size={14} /></a></div>
                  {!findings ? (
                    <div className="card-b dim" style={{ fontSize: 13 }}>Computing findings…</div>
                  ) : findings.length === 0 ? (
                    <div className="card-b dim" style={{ fontSize: 13 }}>Nothing open in this project.</div>
                  ) : (
                    <ul className="card-b" style={{ listStyle: 'none', margin: 0, display: 'grid', gap: 8 }}>
                      {findings.slice(0, 6).map((f) => (
                        <li key={f.fingerprint} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'center' }}>
                          <Sev s={f.severity} />
                          <span className="truncate" style={{ fontSize: 13 }} title={f.title}>{f.title}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="card" aria-labelledby="proj-kinds">
                  <div className="card-h"><span className="card-t" id="proj-kinds">What the agents did</span><span className="label">events</span></div>
                  <ul className="card-b" style={{ listStyle: 'none', margin: 0, display: 'grid', gap: 8 }}>
                    {cats.map(([cat, n]) => (
                      <li key={cat} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center', fontSize: 13 }}>
                        <Icon name={CATEGORY_ICON[cat] ?? 'file'} size={14} />
                        <span>{categoryLabel(cat)}</span>
                        <span className="mono dim" style={{ fontSize: 12 }}>{fmt.n(n)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Loading state in the page's own layout, so nothing shifts when data lands. */
function ProjectSkeleton({ name }: { name: string }) {
  return (
    <div className="scroll" id="vf-scroll">
      <div className="page" aria-busy="true">
        <span className="sk" style={{ display: 'block', height: 26, width: 90, marginBottom: 14 }} />
        <span className="label">Project</span>
        <h1 style={{ margin: '4px 0 10px' }}>{name}</h1>
        <span className="sk" style={{ display: 'block', height: 14, width: 260, marginBottom: 24 }} />
        <div className="kpis">{[0, 1, 2, 3].map((i) => <div className="kpi" key={i}><span className="sk" style={{ height: 10, width: 70 }} /><span className="sk" style={{ height: 28, width: 100 }} /><span className="sk" style={{ height: 12, width: 120 }} /></div>)}</div>
        <div className="proj-grid">
          <div className="card"><div className="card-b"><span className="sk" style={{ display: 'block', height: 220 }} /></div></div>
          <div className="card"><div className="card-b"><span className="sk" style={{ display: 'block', height: 220 }} /></div></div>
        </div>
      </div>
    </div>
  );
}
