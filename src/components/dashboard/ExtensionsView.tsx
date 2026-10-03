import { AnimatePresence, motion } from 'framer-motion';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  getExtensionDetail,
  getExtensions,
  scanAllExtensions,
  scanExtension,
  type ConfigRisk,
  type ExtensionDetail,
  type ExtensionItem,
  type ExtensionKind,
  type ExtensionScope,
  type ExtensionsResponse,
  type RiskLevel,
  type SecurityReport,
} from '../../lib/api';
import { agentLabel } from '../forest/AgentMark';
import { Dropdown } from '../forest/Dropdown';
import { fmt, project, shortId } from '../forest/format';
import { Icon } from '../forest/icons';
import { EASE_OUT } from '../forest/motion';
import { Agent, Seg } from '../forest/ui';

export const SCOPE_LABEL: Record<ExtensionScope, string> = {
  user: 'Global',
  project: 'Project',
  local: 'Local',
  plugin: 'Plugin',
  builtin: 'Built-in',
  managed: 'Managed',
  desktop: 'Desktop app',
};
const SCOPE_HINT: Record<ExtensionScope, string> = {
  user: "In the agent's global config, available in every project.",
  project: 'Checked into the project, shared with everyone who clones it.',
  local: 'Configured for one project on this machine only.',
  plugin: 'Shipped inside a plugin.',
  builtin: 'Bundled with the agent.',
  managed: 'Pushed by an administrator.',
  desktop: "In the Claude desktop app's config.",
};
const KIND_LABEL: Record<ExtensionKind, string> = { mcp: 'MCP server', skill: 'Skill', plugin: 'Plugin' };
const KIND_ICON: Record<ExtensionKind, string> = { mcp: 'plug', skill: 'layers', plugin: 'puzzle' };
const RISK_CHIP: Record<string, string> = { critical: 'c-critical', high: 'c-critical', medium: 'c-warn', low: 'c-info', ok: 'c-ok' };

type UseFilter = 'all' | 'used' | 'unused' | 'missing';
type SortKey = 'calls' | 'sessions' | 'recent' | 'name';
const PAGE = 100;
const DEFAULT_USE: UseFilter = 'used';

/** The installed list an extension belongs to (Activity → MCP / Skills → Installed, or Plugins). */
function installedListHref(key: string): string {
  const kind = key.split(':')[0];
  return `#/metrics-history?tab=${kind}`;
}
const BACK_LABEL: Record<ExtensionKind, string> = { mcp: 'MCP servers', skill: 'Skills', plugin: 'Plugins' };

/** The full details page. */
export function extensionPageHref(key: string): string {
  return `#/extensions/${encodeURIComponent(key)}`;
}

interface ExtensionsViewProps {
  kind: ExtensionKind;
  /** The Activity range; uses, sessions and failures count only this window (0 = all time). */
  days: number;
  /** Set when the page already has an agent filter; the card then hides its own. */
  agent?: string;
  /** The Plugins page has no activity summary above, so the card brings its own numbers. */
  showKpis?: boolean;
}

const KIND_PLURAL: Record<ExtensionKind, string> = { mcp: 'MCP servers', skill: 'skills', plugin: 'plugins' };
const KIND_TITLE: Record<ExtensionKind, string> = { mcp: 'MCP servers', skill: 'Skills', plugin: 'Plugins' };

/** Installed extensions with usage for the range, shared by the Activity pages and their KPIs. A negative `days` skips the fetch. */
export function useExtensions(days: number): { data: ExtensionsResponse | null; error: boolean } {
  const q = useQuery({
    queryKey: ['extensions', days],
    queryFn: () => getExtensions(false, days),
    enabled: days >= 0,
    refetchInterval: 60000,
    placeholderData: keepPreviousData,
  });
  return { data: q.data ?? null, error: q.isError };
}

/** Everything installed of one kind, with usage for the range and risk: a card in an Activity page. */
export function ExtensionsView({ kind, days, agent: pageAgent, showKpis }: ExtensionsViewProps) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['extensions'] });
  const { data, error } = useExtensions(days);
  // Opens on what sessions used in the range; "Any" lists everything installed.
  const [use, setUse] = useState<UseFilter>(DEFAULT_USE);
  const [ownAgent, setAgent] = useState('');
  const agent = pageAgent ?? ownAgent;
  const [scope, setScope] = useState('');
  const [proj, setProj] = useState('');
  const [q, setQ] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>('calls');
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const now = new Date().toISOString();

  const openKey = setOpen;

  // A running "scan all" reports progress through the list payload; poll it until done.
  useEffect(() => {
    if (!data?.scan.running && !scanning) return;
    const t = window.setTimeout(() => {
      refresh();
      if (!data?.scan.running) setScanning(false);
    }, 1500);
    return () => window.clearTimeout(t);
  }, [data, scanning]);

  const items = useMemo(() => (data?.items ?? []).filter((i) => i.kind === kind), [data, kind]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = items.filter((i) => {
      if (use === 'used' && !i.usage.calls) return false;
      if (use === 'unused' && (i.ever_used || !i.installed)) return false;
      if (use === 'missing' && i.installed) return false;
      if (agent && !i.agents.includes(agent)) return false;
      if (scope && !i.scopes.includes(scope as ExtensionScope)) return false;
      if (proj && !i.projects.includes(proj)) return false;
      if (flaggedOnly && i.risk.level !== 'high' && i.risk.level !== 'critical') return false;
      if (needle && !`${i.name} ${i.display_name} ${i.description ?? ''} ${i.marketplace ?? ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const by: Record<SortKey, (a: ExtensionItem, b: ExtensionItem) => number> = {
      calls: (a, b) => b.usage.calls - a.usage.calls || b.usage.sessions - a.usage.sessions,
      sessions: (a, b) => b.usage.sessions - a.usage.sessions || b.usage.calls - a.usage.calls,
      recent: (a, b) => (b.usage.last_used ?? '').localeCompare(a.usage.last_used ?? ''),
      name: (a, b) => a.display_name.localeCompare(b.display_name),
    };
    return out.sort((a, b) => by[sort](a, b) || a.display_name.localeCompare(b.display_name));
  }, [items, use, agent, scope, proj, q, sort, flaggedOnly]);

  const s = data?.summary[kind];
  const agents = useMemo(() => [...new Set(items.flatMap((i) => i.agents))].sort(), [items]);
  const scopes = useMemo(() => [...new Set(items.flatMap((i) => i.scopes))].sort(), [items]);
  const flagged = s?.flagged ?? 0;
  const unscanned = kind === 'mcp' ? 0 : items.filter((i) => i.installed && !i.risk.scanned).length;

  const scanAll = async () => {
    setScanning(true);
    try {
      await scanAllExtensions();
    } finally {
      refresh();
    }
  };

  const filtered = !!(ownAgent || scope || proj || q || flaggedOnly || use !== DEFAULT_USE);
  const range = days === 0 ? 'all time' : days === 1 ? '24h' : `${days}d`;
  const trendDays = days > 0 && days <= 7 ? 7 : 30;
  const Th = ({ k, children, num }: { k: SortKey; children: ReactNode; num?: boolean }) => (
    <th style={num ? { textAlign: 'right' } : undefined} aria-sort={sort === k ? 'descending' : undefined}>
      <button type="button" onClick={() => setSort(k)} style={sort === k ? { color: 'var(--v-fg)' } : undefined}>
        {children}
        {sort === k && <Icon name="down" size={11} />}
      </button>
    </th>
  );

  const actions = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
      {kind !== 'mcp' && (
        <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={scanAll} disabled={!data || scanning || data.scan.running || !unscanned}
          title={unscanned ? `Run the package security scan on ${unscanned} ${KIND_PLURAL[kind]}` : `Every one of these ${KIND_PLURAL[kind]} is scanned`}>
          <Icon name="lock" size={14} />
          {!data ? 'Security scan' : data.scan.running ? `Scanning ${data.scan.done}/${data.scan.total}` : unscanned ? `Scan ${unscanned} unscanned` : 'All scanned'}
        </button>
      )}
      <button type="button" className="iconbtn" onClick={() => void getExtensions(true, days).finally(refresh)} aria-label="Re-read agent configs" title="Re-read agent configs">
        <Icon name="replay" size={15} />
      </button>
    </div>
  );

  return (
    <>
      {showKpis && (
        <div className="kpis">
          <div className="kpi">
            <span className="label">Installed</span>
            <span className="v">{s ? fmt.n(s.installed) : '—'}</span>
            <span className="d">{s ? `${s.project_scoped} scoped to a project` : ' '}</span>
          </div>
          <div className="kpi">
            <span className="label">Used · {range}</span>
            <span className="v">{s ? fmt.n(s.used) : '—'}</span>
            <span className="d">{kind === 'plugin' ? 'through their skills and servers' : s ? `${s.not_installed} used but not in any config` : ' '}</span>
          </div>
          <div className="kpi">
            <span className="label">Never used</span>
            <span className="v">{s ? fmt.n(s.unused) : '—'}</span>
            <span className="d">{s ? `of ${s.installed} installed` : ' '}</span>
          </div>
          <div className="kpi">
            <span className="label">Flagged</span>
            <span className="v" style={flagged ? { color: 'var(--v-alert)' } : undefined}>{s ? fmt.n(flagged) : '—'}</span>
            <span className="d">{s ? (kind === 'mcp' ? 'by launch checks' : unscanned ? `${unscanned} not scanned yet` : 'every package scanned') : ' '}</span>
          </div>
        </div>
      )}

      <section className="card" style={{ marginTop: 16, overflow: 'hidden' }}>
        <div className="card-h" style={{ paddingBottom: 12 }}>
          <span className="card-t">{KIND_TITLE[kind]}</span>
          {/* Same "installed" as the page's KPI; rows that no config lists are called out so the counts add up. */}
          <span className="label">{data && s ? (() => {
            const outside = rows.filter((i) => !i.installed).length;
            return `${rows.length} shown${outside ? ` (${outside} not in any config)` : ''} · ${s.installed} installed`;
          })() : '…'}</span>
        </div>
        <div className="toolbar" style={{ padding: '0 20px', marginBottom: 12 }}>
          <label className="vfield">
            <Icon name="search" size={14} />
            <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Filter by name or description" aria-label={`Filter ${KIND_PLURAL[kind]}`} />
          </label>
          {pageAgent === undefined && (
            <Dropdown label="Agent" value={ownAgent} onChange={setAgent} placeholder="All agents"
              options={[{ value: '', label: 'All agents' }, ...agents.map((a) => ({ value: a, label: agentLabel(a), meta: items.filter((i) => i.agents.includes(a)).length }))]} />
          )}
          <Dropdown label="Scope" value={scope} onChange={setScope} placeholder="All scopes"
            options={[{ value: '', label: 'All scopes' }, ...scopes.map((sc) => ({ value: sc, label: SCOPE_LABEL[sc] ?? sc, meta: items.filter((i) => i.scopes.includes(sc)).length }))]} />
          {(data?.projects.length ?? 0) > 0 && (
            <Dropdown label="Project" value={proj} onChange={setProj} placeholder="Any project" searchable
              options={[{ value: '', label: 'Any project' }, ...(data?.projects ?? []).map((p) => ({ value: p, label: project(p), meta: items.filter((i) => i.projects.includes(p)).length || undefined }))]} />
          )}
          <Seg
            id="vf-extuse"
            value={use}
            onChange={(k) => { setUse(k); setShown(PAGE); }}
            options={[{ k: 'all', l: 'Any' }, { k: 'used', l: 'Used' }, { k: 'unused', l: 'Never used' }, ...(kind === 'plugin' ? [] : [{ k: 'missing' as const, l: 'Not installed' }])]}
          />
          <button
            type="button"
            className="vbtn vbtn-quiet vbtn-sm"
            aria-pressed={flaggedOnly}
            onClick={() => { setFlaggedOnly((f) => !f); setShown(PAGE); }}
            style={flaggedOnly ? { borderColor: 'var(--v-alert)', color: 'var(--v-alert)' } : undefined}>
            <Icon name="findings" size={14} />Flagged
            <span className="mono faint" style={{ fontSize: 11 }}>{data ? flagged : '…'}</span>
          </button>
          {filtered && (
            <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={() => { setAgent(''); setScope(''); setProj(''); setQ(''); setUse(DEFAULT_USE); setFlaggedOnly(false); }}>Clear</button>
          )}
          {actions}
        </div>

        <div style={{ overflowX: 'auto', borderTop: '1px solid var(--v-line)' }}>
          <table className="t">
            <thead>
              <tr>
                <Th k="name">{kind === 'mcp' ? 'Server' : KIND_LABEL[kind]}</Th>
                <th>Agents</th>
                <th>Installed</th>
                <Th k="sessions" num>Sessions</Th>
                <Th k="calls" num>Uses</Th>
                <th aria-label={`Daily uses, last ${trendDays} days`}>{trendDays}d</th>
                <Th k="recent">Last used</Th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((i) => (
                <tr key={i.key} className="click" data-sel={open === i.key} tabIndex={0} onClick={() => openKey(i.key)} onKeyDown={(e) => e.key === 'Enter' && openKey(i.key)}>
                  <td style={{ maxWidth: 420 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span className="dim" style={{ display: 'inline-flex' }} title={KIND_LABEL[i.kind]}><Icon name={KIND_ICON[i.kind]} size={15} /></span>
                      <span className="truncate" style={{ fontWeight: 500, color: i.installed && !i.ever_used ? 'var(--v-dim)' : undefined }}>{i.display_name}</span>
                      {i.version && <span className="mono faint" style={{ fontSize: 11 }}>{i.version}</span>}
                      {i.enabled === false && <span className="vchip c-dim">off</span>}
                    </div>
                    <span className="truncate faint" style={{ display: 'block', fontSize: 12, paddingLeft: 23 }}>
                      {i.description ?? (i.plugin ? `in ${i.plugin.replace(/^plugin:/, '')}` : i.kind === 'mcp' && i.transport ? i.transport : KIND_LABEL[i.kind])}
                    </span>
                  </td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 6 }}>{i.agents.map((a) => <span key={a} title={agentLabel(a)}><Agent id={a} label={false} /></span>)}</span>
                  </td>
                  <td><ScopeChips item={i} /></td>
                  <td className="num">{i.usage.sessions || '—'}</td>
                  <td className="num">
                    {i.usage.calls ? fmt.n(i.usage.calls) : '—'}
                    {i.usage.errors > 0 && <span style={{ color: 'var(--v-alert)', marginLeft: 6 }} title={`${i.usage.errors} failed`}>{fmt.pct(i.usage.error_rate)}</span>}
                  </td>
                  <td><Spark values={i.usage.trend} /></td>
                  <td className="mono dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{i.usage.last_used ? fmt.ago(i.usage.last_used, now) : <span className="faint">never</span>}</td>
                  <td><RiskChip level={i.risk.level} scanned={i.risk.scanned} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data && !error && <div className="empty">Reading agent configs…</div>}
          {error && !data && <div className="empty">Collector offline — extensions unavailable.</div>}
          {data && rows.length === 0 && (
            <div className="empty">
              {filtered
                ? `No ${KIND_PLURAL[kind]} match these filters.`
                : items.length === 0
                  ? `No ${KIND_PLURAL[kind]} found in any agent's config.`
                  : <>No {KIND_PLURAL[kind]} used in {range}. <button type="button" className="vbtn vbtn-quiet vbtn-sm" style={{ marginLeft: 8 }} onClick={() => setUse('all')}>Show all {items.length}</button></>}
            </div>
          )}
          {rows.length > shown && (
            <div style={{ textAlign: 'center', padding: 12, borderTop: '1px solid var(--v-line)' }}>
              <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}</button>
            </div>
          )}
        </div>
      </section>
      <ExtensionDrawer extKey={open} onClose={() => openKey(null)} />
    </>
  );
}

function ScopeChips({ item }: { item: ExtensionItem }) {
  if (!item.installed) {
    return item.origin
      ? <span className="vchip c-dim" title="Provided by the agent app, so no config file lists it">{item.origin}</span>
      : <span className="vchip c-warn" title="Used in sessions, but no agent config on this machine lists it now">not on disk</span>;
  }
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {item.scopes.map((sc) => (
        <span key={sc} className={`vchip ${sc === 'user' ? 'c-fg' : sc === 'project' || sc === 'local' ? 'c-info' : 'c-dim'}`} title={SCOPE_HINT[sc]}>
          {SCOPE_LABEL[sc] ?? sc}
          {(sc === 'project' || sc === 'local') && item.projects.length > 0 && ` · ${item.projects.length}`}
        </span>
      ))}
    </span>
  );
}

function RiskChip({ level, scanned }: { level: RiskLevel; scanned: boolean }) {
  if (!scanned || !level) return <span className="faint mono" style={{ fontSize: 11 }}>—</span>;
  return <span className={`vchip ${RISK_CHIP[level] ?? 'c-dim'}`}><span className="dot" />{level === 'ok' ? 'clean' : level}</span>;
}

/** Daily uses as flat bars; zero days stay a hairline so the window reads at a glance.
 *  `fluid` stretches to the container's width (the drawer and the details page). */
function Spark({ values, width = 64, height = 18, fluid }: { values: number[]; width?: number; height?: number; fluid?: boolean }) {
  const max = Math.max(1, ...values);
  const w = width / values.length;
  const size = fluid
    ? { width: '100%', height, viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' as const, style: { display: 'block' } }
    : { width, height };
  if (!values.some(Boolean)) return <svg {...size} aria-hidden="true"><line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--v-line)" vectorEffect="non-scaling-stroke" /></svg>;
  return (
    <svg {...size} aria-label={`${values.reduce((a, b) => a + b, 0)} uses in the last ${values.length} days`} role="img">
      {values.map((v, i) => {
        const h = v ? Math.max(2, (v / max) * height) : 1;
        return <rect key={i} x={i * w + 0.5} y={height - h} width={Math.max(1, w - 1)} height={h} rx={0.5} fill={v ? 'var(--v-hot)' : 'var(--v-line)'} />;
      })}
    </svg>
  );
}

/** One cache entry per extension, shared by the peek and the details page, so opening details is instant. */
function useExtensionDetail(key: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['extensionDetail', key],
    queryFn: () => getExtensionDetail(key!),
    enabled: !!key,
  });
  const [scanning, setScanning] = useState(false);
  const scan = async () => {
    if (!key) return;
    setScanning(true);
    try {
      const report = await scanExtension(key);
      queryClient.setQueryData<ExtensionDetail>(['extensionDetail', key], (d) => (d ? { ...d, security: report } : d));
      void queryClient.invalidateQueries({ queryKey: ['extensions'] });
    } finally {
      setScanning(false);
    }
  };
  return { d: query.data ?? null, failed: query.isError, scanning, scan };
}

function subtitle(d: ExtensionDetail): string {
  return `${KIND_LABEL[d.kind]}${d.marketplace ? ` · ${d.marketplace}` : ''}${d.version ? ` · v${d.version}` : ''}`;
}

/** The side panel: enough to recognise the extension and judge it at a glance. Everything else is on the details page. */
function ExtensionDrawer({ extKey, onClose }: { extKey: string | null; onClose: () => void }) {
  const { d, failed } = useExtensionDetail(extKey);
  const now = new Date().toISOString();

  return (
    <AnimatePresence>
      {extKey && (
        <>
          <motion.div className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <motion.aside
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={d?.display_name ?? 'Extension'}
            initial={{ transform: 'translateX(105%)' }}
            animate={{ transform: 'translateX(0%)' }}
            exit={{ transform: 'translateX(105%)', transition: { duration: 0.2, ease: EASE_OUT } }}
            transition={{ duration: 0.38, ease: [0.32, 0.72, 0, 1] }}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}>
            <div className="drawer-h">
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="mono faint" style={{ fontSize: 11 }}>{d ? subtitle(d) : extKey}</span>
                <h2 style={{ margin: '4px 0 0', fontSize: 17, lineHeight: '24px', fontWeight: 600, letterSpacing: '-0.01em', overflowWrap: 'anywhere' }}>{d?.display_name ?? extKey.split(':').slice(1).join(':')}</h2>
              </div>
              <button type="button" className="iconbtn" onClick={onClose} aria-label="Close" autoFocus><Icon name="close" /></button>
            </div>
            <div className="drawer-b">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {failed && <p className="dim" style={{ margin: 0 }}>Couldn't load this extension.</p>}
                {!d && !failed && <p className="dim" style={{ margin: 0 }}>Loading…</p>}
                {d && <PeekBody d={d} now={now} />}
              </div>
            </div>
            <div style={{ padding: 16, borderTop: '1px solid var(--v-line)', display: 'flex', gap: 8 }}>
              <a className="vbtn vbtn-primary" style={{ flex: 1, justifyContent: 'center' }} href={extensionPageHref(extKey)}>
                Open details <Icon name="arrow" size={15} />
              </a>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function PeekBody({ d, now }: { d: ExtensionDetail; now: string }) {
  const u = d.usage;
  const trend30 = u.trend.slice(-30);
  const risk = d.risk;
  const topTools = d.tools.slice(0, 3);
  return (
    <>
      {d.description && (
        <p className="dim" style={{ margin: 0, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{d.description}</p>
      )}
      <UsageKpis d={d} now={now} compact />
      <Section title="Last 30 days" aside={Object.entries(u.agents).map(([a, n]) => `${agentLabel(a)} ${n}`).join(' · ') || undefined}>
        <Spark values={trend30} width={300} height={32} fluid />
      </Section>
      <Section title="Installed" aside={d.installed && d.installs.length > 3 ? `${d.installs.length} places` : undefined}>
        {!d.installed ? (
          <span className="dim" style={{ fontSize: 13 }}>{d.origin ?? 'Not in any config cot can read'}</span>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {d.installs.slice(0, 3).map((i, n) => (
              <div key={n} style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                <Agent id={i.agent} />
                <ScopeChip scope={i.scope} />
                {i.project && <span className="mono truncate" style={{ fontSize: 12 }}>{project(i.project)}</span>}
                {i.enabled === false && <span className="vchip c-dim" style={{ marginLeft: 'auto' }}>disabled</span>}
                {i.enabled == null && <span className="vchip c-warn" style={{ marginLeft: 'auto' }}>awaiting approval</span>}
              </div>
            ))}
            {d.installs.length > 3 && <span className="mono faint" style={{ fontSize: 11 }}>+{d.installs.length - 3} more</span>}
          </div>
        )}
      </Section>
      {(d.installed || risk.scanned) && (
        <Section title="Risk">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
            {risk.scanned ? <RiskChip level={risk.level} scanned /> : <span className="dim">Not scanned yet</span>}
            {risk.verdict && <span className="dim">{risk.verdict}{risk.score != null ? ` · ${risk.score}/100` : ''}</span>}
            {risk.findings > 0 && <span className="mono faint" style={{ fontSize: 11, marginLeft: 'auto' }}>{risk.findings} finding{risk.findings === 1 ? '' : 's'}</span>}
          </div>
        </Section>
      )}
      {topTools.length > 0 && (
        <Section title="Top tools" aside={d.tools.length > 3 ? `of ${d.tools.length}` : undefined}>
          <div style={{ display: 'grid', gap: 4 }}>
            {topTools.map((t) => (
              <div key={t.tool} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                <span className="mono truncate" style={{ fontSize: 12 }}>{t.tool}</span>
                <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 11, whiteSpace: 'nowrap' }}>{fmt.n(t.calls)}{t.errors ? ` · ${t.errors} failed` : ''}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
      {d.children.length > 0 && (
        <Section title="Ships with">
          <span className="dim" style={{ fontSize: 13 }}>
            {[
              countOf(d.children.filter((c) => c.kind === 'skill').length, 'skill'),
              countOf(d.children.filter((c) => c.kind === 'mcp').length, 'MCP server'),
              d.contents?.commands ? countOf(d.contents.commands, 'command') : null,
              d.contents?.hooks ? countOf(d.contents.hooks, 'hook') : null,
            ].filter(Boolean).join(' · ')}
          </span>
        </Section>
      )}
    </>
  );
}

function countOf(n: number, noun: string): string | null {
  return n ? `${n} ${noun}${n === 1 ? '' : 's'}` : null;
}

function ScopeChip({ scope }: { scope: ExtensionScope }) {
  return (
    <span className={`vchip ${scope === 'user' ? 'c-fg' : scope === 'project' || scope === 'local' ? 'c-info' : 'c-dim'}`} title={SCOPE_HINT[scope]}>
      {SCOPE_LABEL[scope] ?? scope}
    </span>
  );
}

function UsageKpis({ d, now, compact }: { d: ExtensionDetail; now: string; compact?: boolean }) {
  const u = d.usage;
  const v = compact ? { fontSize: 22 } : undefined;
  return (
    // The full page keeps the stylesheet's 4-up grid, which folds to 2×2 on narrow screens.
    <div className="kpis" style={compact ? { gridTemplateColumns: 'repeat(3, 1fr)', flexShrink: 0 } : undefined}>
      <div className="kpi"><span className="label">Sessions</span><span className="v" style={v}>{fmt.n(u.sessions)}</span><span className="d">{u.projects ? `${u.projects} project${u.projects === 1 ? '' : 's'}` : ' '}</span></div>
      <div className="kpi">
        <span className="label">{d.kind === 'mcp' ? 'Calls' : 'Uses'}</span>
        <span className="v" style={v}>{fmt.n(u.calls)}</span>
        <span className="d">{u.errors ? <span style={{ color: 'var(--v-alert)' }}>{u.errors} failed · {fmt.pct(u.error_rate)}</span> : u.p50_ms != null ? `p50 ${fmt.ms(u.p50_ms)}` : ' '}</span>
      </div>
      <div className="kpi"><span className="label">Last used</span><span className="v" style={v}>{u.last_used ? fmt.ago(u.last_used, now) : '—'}</span><span className="d">{u.first_used ? `since ${fmt.day(u.first_used)}` : 'never'}</span></div>
      {!compact && (
        <div className="kpi">
          <span className="label">Installed in</span>
          <span className="v">{d.installed ? d.installs.length : '—'}</span>
          <span className="d">{d.installed ? `${d.agents.map(agentLabel).join(', ')}` : d.origin ?? 'no config lists it'}</span>
        </div>
      )}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="label">{title}</span>
        {aside && <span className="mono faint" style={{ fontSize: 11, marginLeft: 'auto' }}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card-b">
        <Section title={title} aside={aside}>{children}</Section>
      </div>
    </div>
  );
}

/** A titled card whose table scrolls inside it, so long lists never stretch the page. The header row stays pinned. */
function TableCard({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-b" style={{ paddingBottom: 8 }}>
        <Section title={title} aside={aside}>{null}</Section>
      </div>
      <div style={{ maxHeight: 420, overflow: 'auto', overscrollBehavior: 'contain' }}>{children}</div>
    </div>
  );
}

const box = { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--v-line)' } as const;

function home(path: string | null | undefined): string {
  if (!path) return '';
  const m = path.match(/^\/Users\/[^/]+(\/.*)?$/) ?? path.match(/^\/home\/[^/]+(\/.*)?$/);
  return m ? `~${m[1] ?? ''}` : path;
}

interface ExtensionDetailViewProps {
  extKey: string;
  onSelect: (sessionId: string, eventId?: number) => void;
}

/** The full page: every install, tool, fact, finding, project and session for one extension. */
export function ExtensionDetailView({ extKey, onSelect }: ExtensionDetailViewProps) {
  const { d, failed, scanning, scan } = useExtensionDetail(extKey);
  const now = new Date().toISOString();

  useEffect(() => {
    document.getElementById('vf-scroll')?.scrollTo({ top: 0 });
  }, [extKey]);

  if (!d) {
    return (
      <div className="scroll" id="vf-scroll">
        <div className="page" aria-busy={!failed}>
          <a href={installedListHref(extKey)} className="dim" style={{ fontSize: 13, textDecoration: 'none', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Icon name="back" size={14} />{BACK_LABEL[extKey.split(':')[0] as ExtensionKind] ?? 'Activity'}</a>
          {failed ? (
            <div className="card empty" style={{ marginTop: 16 }}>Couldn't load this extension.</div>
          ) : (
            <>
              <span className="sk" style={{ display: 'block', height: 28, width: '40%', margin: '16px 0 12px' }} />
              <span className="sk" style={{ display: 'block', height: 18, width: 300, marginBottom: 24 }} />
              <div className="kpis">{[0, 1, 2, 3].map((i) => <div className="kpi" key={i}><span className="sk" style={{ height: 10, width: 70 }} /><span className="sk" style={{ height: 28, width: 90 }} /></div>)}</div>
            </>
          )}
        </div>
      </div>
    );
  }

  const u = d.usage;
  const facts: [string, ReactNode][] = [];
  if (d.author) facts.push(['Author', d.author]);
  if (d.license) facts.push(['License', d.license]);
  if (d.category) facts.push(['Category', d.category]);
  if (d.homepage) facts.push(['Homepage', <a key="h" href={d.homepage} target="_blank" rel="noreferrer" className="truncate" style={{ display: 'block' }}>{d.homepage}</a>]);
  if (d.repository && d.repository !== d.homepage) facts.push(['Repository', <a key="r" href={d.repository} target="_blank" rel="noreferrer" className="truncate" style={{ display: 'block' }}>{d.repository}</a>]);
  if (d.installed_at) facts.push(['Installed', fmt.day(d.installed_at)]);
  if (d.updated_at) facts.push(['Updated', fmt.day(d.updated_at)]);
  if (d.git_sha) facts.push(['Commit', <span key="g" className="mono">{d.git_sha.slice(0, 10)}</span>]);
  if (d.files != null) facts.push(['Files', `${d.files}${d.size_bytes != null ? ` · ${fmt.bytes(d.size_bytes)}` : ''}`]);
  if (d.allowed_tools?.length) facts.push(['Allowed tools', <span key="t" className="mono" style={{ fontSize: 12 }}>{d.allowed_tools.join(', ')}</span>]);
  if (d.native_usage?.count != null) facts.push(['Agent counter', `${d.native_usage.count} uses${d.native_usage.last_used ? ` · last ${fmt.day(d.native_usage.last_used)}` : ''}`]);
  if (d.mcp) {
    const m = d.mcp;
    facts.push(['Transport', m.transport]);
    if (m.command) facts.push(['Command', <code key="c" className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{[m.command_path ? home(m.command_path) : m.command, ...m.args.map(home)].join(' ')}</code>]);
    if (m.url_host) facts.push(['Endpoint', <span key="u" className="mono" style={{ fontSize: 12 }}>{m.url_scheme}://{m.url_host}</span>]);
    if (m.env_keys.length) facts.push(['Env', <span key="e" className="mono" style={{ fontSize: 12 }}>{m.env_keys.join(', ')}</span>]);
    if (m.header_keys.length) facts.push(['Headers', <span key="hd" className="mono" style={{ fontSize: 12 }}>{m.header_keys.join(', ')}</span>]);
  }
  facts.push(['Key', <span key="k" className="mono" style={{ fontSize: 12 }}>{d.key}</span>]);
  const knownUnused = (d.mcp_tools_known ?? []).filter((t) => !d.tools.some((x) => x.tool === t.tool));

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <a href={installedListHref(extKey)} className="dim" style={{ fontSize: 13, textDecoration: 'none', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Icon name="back" size={14} />{BACK_LABEL[extKey.split(':')[0] as ExtensionKind] ?? 'Activity'}</a>
        <div className="ph" style={{ marginTop: 12 }}>
          <div style={{ minWidth: 0, maxWidth: 760 }}>
            <span className="label">{subtitle(d)}</span>
            <h1 style={{ overflowWrap: 'anywhere' }}>{d.display_name}</h1>
            {d.description && <p style={{ overflowWrap: 'anywhere' }}>{d.description}</p>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
              {d.agents.map((a) => <Agent key={a} id={a} />)}
              {d.scopes.map((sc) => <ScopeChip key={sc} scope={sc} />)}
              {d.enabled === false && <span className="vchip c-dim">disabled</span>}
              {d.risk.scanned && <RiskChip level={d.risk.level} scanned />}
            </div>
          </div>
          {d.kind !== 'plugin' && d.usage.calls > 0 && (
            // Same shape as activityHash() in MetricsHistoryView (not imported, so Activity stays code-split).
            <a className="vbtn vbtn-quiet vbtn-sm" href={`#/metrics-history?tab=${d.kind}&group=${encodeURIComponent(d.display_name)}`}>
              <Icon name="activity" size={14} />See in Activity
            </a>
          )}
        </div>

        <UsageKpis d={d} now={now} />

        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16, minWidth: 0 }}>
            <Card title="Last 90 days" aside={Object.entries(u.agents).map(([a, n]) => `${agentLabel(a)} ${n}`).join(' · ') || 'no uses'}>
              <Spark values={u.trend} width={540} height={56} fluid />
            </Card>

            {d.tools.length > 0 && (
              <TableCard title="Tools called" aside={knownUnused.length ? `${knownUnused.length} more never called` : `${d.tools.length}`}>
                <table className="t">
                  <thead><tr><th>Tool</th><th style={{ textAlign: 'right' }}>Calls</th><th style={{ textAlign: 'right' }}>Failed</th><th style={{ textAlign: 'right' }}>p50</th></tr></thead>
                  <tbody>
                    {d.tools.map((t) => (
                      <tr key={t.tool}>
                        <td className="mono" style={{ fontSize: 12 }}>{t.tool}</td>
                        <td className="num">{fmt.n(t.calls)}</td>
                        <td className="num" style={t.errors ? { color: 'var(--v-alert)' } : undefined}>{t.errors || '—'}</td>
                        <td className="num">{t.p50_ms != null ? fmt.ms(t.p50_ms) : '—'}</td>
                      </tr>
                    ))}
                    {knownUnused.map((t) => (
                      <tr key={t.tool} title={t.description ?? undefined}>
                        <td className="mono faint" style={{ fontSize: 12 }}>{t.tool}</td>
                        <td className="num faint">0</td>
                        <td className="num faint">—</td>
                        <td className="num faint">—</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableCard>
            )}

            {d.children.length > 0 && (
              <Card title="Ships with" aside={d.contents ? [countOf(d.contents.commands, 'command'), countOf(d.contents.agents, 'agent'), countOf(d.contents.hooks, 'hook')].filter(Boolean).join(' · ') || undefined : undefined}>
                <div style={{ display: 'grid', gap: 6 }}>
                  {d.children.map((c) => (
                    <a key={c.key} href={extensionPageHref(c.key)} className="hov" style={{ ...box, textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Icon name={KIND_ICON[c.kind]} size={14} />
                      <span className="truncate" style={{ fontWeight: 500, fontSize: 13 }}>{c.display_name}</span>
                      <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 11, whiteSpace: 'nowrap' }}>{c.usage.calls ? `${fmt.n(c.usage.calls)} uses` : 'unused'}</span>
                    </a>
                  ))}
                </div>
              </Card>
            )}

            <TableCard title="Sessions" aside={d.sessions.length >= 100 ? 'latest 100' : `${d.sessions.length}`}>
              {d.sessions.length === 0 ? (
                <div className="empty">No session has used it yet.</div>
              ) : (
                <table className="t">
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Agent</th>
                      <th style={{ textAlign: 'right' }}>Uses</th>
                      <th>Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.sessions.map((s) => (
                      <tr key={s.id} className="click" tabIndex={0} onClick={() => onSelect(s.id, s.first_event_id)} onKeyDown={(e) => e.key === 'Enter' && onSelect(s.id, s.first_event_id)}>
                        <td style={{ maxWidth: 280 }}>
                          <span className="truncate" style={{ display: 'block', fontWeight: 500 }}>{project(s.cwd)}</span>
                          <span className="mono faint" style={{ fontSize: 11 }}>{shortId(s.id)}</span>
                        </td>
                        <td><Agent id={s.source} /></td>
                        <td className="num">{fmt.n(s.uses)}</td>
                        <td className="mono dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{s.last_used ? fmt.ago(s.last_used, now) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </TableCard>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16, minWidth: 0 }}>
            <Card title="Where it's installed" aside={d.installed ? `${d.installs.length} place${d.installs.length === 1 ? '' : 's'}` : undefined}>
              {!d.installed && (
                <div style={{ ...box, background: 'var(--v-wash)' }}>
                  <b style={{ fontSize: 13 }}>{d.origin ?? 'Not in any config cot can read'}</b>
                  <p className="dim" style={{ margin: '4px 0 0', fontSize: 12 }}>
                    {d.origin
                      ? 'Provided by the agent app itself, so no config file lists it.'
                      : 'Sessions used it, but no agent config on this machine lists it now. It may have been removed, or it ships inside an app.'}
                  </p>
                </div>
              )}
              {d.installs.map((i, n) => (
                <div key={n} style={{ ...box, display: 'grid', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Agent id={i.agent} />
                    <ScopeChip scope={i.scope} />
                    {i.project && <span className="mono" style={{ fontSize: 12 }}>{project(i.project)}</span>}
                    <span style={{ marginLeft: 'auto' }}>
                      {i.enabled === false ? <span className="vchip c-dim">disabled</span> : i.enabled == null ? <span className="vchip c-warn" title="Claude Code asks before it starts project MCP servers">awaiting approval</span> : <span className="vchip c-ok"><span className="dot" />enabled</span>}
                    </span>
                  </div>
                  {(i.path || i.config_file) && <span className="mono faint truncate" style={{ fontSize: 11 }} title={i.path ?? i.config_file ?? ''}>{home(i.config_file ?? i.path)}</span>}
                  {i.plugin && <a href={extensionPageHref(i.plugin)} className="mono" style={{ fontSize: 11, color: 'var(--v-dim)', textDecoration: 'none' }}>from {i.plugin.replace(/^plugin:/, '')} →</a>}
                </div>
              ))}
              {d.shadows?.map((sh, n) => (
                <p key={n} className="dim" style={{ margin: 0, fontSize: 12 }}>
                  In <b>{project(sh.project)}</b>, the project copy overrides the global one for {agentLabel(sh.agent)}.
                </p>
              ))}
            </Card>

            <Card title="Details">
              <dl style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: '8px 12px', margin: 0, fontSize: 13 }}>
                {facts.map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt className="faint">{k}</dt>
                    <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>

            <SecurityCard d={d} scanning={scanning} onScan={scan} />

            {d.projects_used.length > 0 && (
              <Card title="Used in projects" aside={`${d.projects_used.length}`}>
                <div style={{ display: 'grid', gap: 6 }}>
                  {d.projects_used.map((p) => (
                    <div key={p.path} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                      <span className="truncate" title={p.path}>{project(p.path)}</span>
                      {p.installed_here && <span className="vchip c-info" title="Installed in this project's config">scoped here</span>}
                      <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 11 }}>{p.sessions} session{p.sessions === 1 ? '' : 's'}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SecurityCard(props: { d: ExtensionDetail; scanning: boolean; onScan: () => void }) {
  const body = Security(props);
  if (!body) return null;
  return <div className="card"><div className="card-b">{body}</div></div>;
}

const SEV_VAR: Record<string, string> = { critical: 'var(--v-alert)', high: 'var(--v-alert)', medium: 'var(--v-amber)', low: 'var(--v-cobalt)', info: 'var(--v-faint)' };
const VERDICT_CHIP: Record<SecurityReport['verdict'], string> = { approved: 'c-ok', review: 'c-warn', rejected: 'c-critical' };

function Security({ d, scanning, onScan }: { d: ExtensionDetail; scanning: boolean; onScan: () => void }) {
  if (d.kind === 'mcp') {
    const risks: ConfigRisk[] = d.risks ?? [];
    if (!d.installed) return null;
    return (
      <Section title="Launch checks" aside={risks.length ? `${risks.length} finding${risks.length === 1 ? '' : 's'}` : 'no issues'}>
        {risks.length === 0 ? (
          <p className="dim" style={{ margin: 0, fontSize: 13 }}>No secrets in the config, pinned or local launch, encrypted endpoint.</p>
        ) : (
          <Findings rows={risks.map((r) => ({ severity: r.severity, title: r.title, detail: r.detail, where: r.project ? project(r.project) : r.scope ? SCOPE_LABEL[r.scope as ExtensionScope] : undefined }))} />
        )}
      </Section>
    );
  }
  const r = d.security;
  const canScan = d.installs.some((i) => i.path);
  if (!canScan) return null;
  return (
    <Section
      title="Security scan"
      aside={
        <button type="button" className="vbtn vbtn-quiet vbtn-sm" disabled={scanning} onClick={onScan}>
          <Icon name="lock" size={13} />{scanning ? 'Scanning…' : r ? 'Rescan' : 'Run scan'}
        </button>
      }>
      {!r ? (
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>Not scanned yet. The scan reads every file offline for secrets, prompt injection, risky execution, exfiltration and over-broad permissions. Nothing is run.</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className={`vchip ${VERDICT_CHIP[r.verdict]}`}><span className="dot" />{r.verdict}</span>
            <span className="tnum" style={{ fontWeight: 600 }}>{r.score}<span className="faint" style={{ fontWeight: 400 }}>/100 · grade {r.grade}</span></span>
            <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 11 }}>scanned {fmt.day(r.scanned_at)}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {r.perspectives.filter((p) => p.status !== 'skipped').map((p) => (
              <span key={p.id} className={`vchip ${p.status === 'pass' ? 'c-ok' : p.status === 'warn' ? 'c-warn' : 'c-critical'}`} title={p.description}>{p.label} {p.score}</span>
            ))}
          </div>
          {r.findings.length > 0 && (
            <Findings rows={r.findings.slice(0, 12).map((f) => ({ severity: f.severity, title: f.title, detail: f.excerpt ?? f.detail, where: f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : undefined }))} />
          )}
          {r.findings.length > 12 && <p className="mono faint" style={{ margin: 0, fontSize: 11 }}>+{r.findings.length - 12} more findings</p>}
        </>
      )}
    </Section>
  );
}

function Findings({ rows }: { rows: { severity: string; title: string; detail?: string | null; where?: string }[] }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.map((f, i) => (
        <div key={i} style={{ ...box, display: 'grid', gap: 2 }}>
          <span className="mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: SEV_VAR[f.severity] ?? 'var(--v-dim)' }}>
            {f.severity}{f.where ? <span className="faint" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}> · {f.where}</span> : null}
          </span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{f.title}</span>
          {f.detail && <span className="dim mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{f.detail}</span>}
        </div>
      ))}
    </div>
  );
}
