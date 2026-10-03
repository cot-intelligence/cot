import { motion } from 'framer-motion';
import { useEffect, useState, type ReactNode } from 'react';
import {
  cleanupRetention,
  getHealth,
  getHookStatus,
  getRetention,
  getSelfAudit,
  getSettings,
  updateRetention,
  type AuditEvent,
  type Health,
  type HookHealthState,
  type HookStatus,
  type HookStatusAgent,
  type RetentionCleanupResult,
  type RetentionStatus,
  type Settings,
} from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { fmt, shortId } from '../forest/format';
import { Icon } from '../forest/icons';
import { listItem, listParent } from '../forest/motion';
import { Agent, Seg } from '../forest/ui';

// Enterprise plan capabilities as listed on cot.run/pricing (same list as the demo).
const ENTERPRISE = [
  { k: 'Org-wide visibility', body: "Every engineer's agent sessions in shared team dashboards, searchable across the org." },
  { k: 'SSO / SAML', body: 'Sign in through the identity provider you already run.' },
  { k: 'Roles and access', body: 'Decide who sees which teams, projects and traces.' },
  { k: 'Retention and audit', body: 'Set how long traces live, and keep a record of who viewed or exported them.' },
  { k: 'Managed collector', body: 'Hosted and run for you, so there is no infrastructure to maintain.' },
  { k: 'Priority support', body: 'Onboarding for your teams and a direct line to the people building cot.' },
];

const HOOK_HEALTH: Record<HookHealthState, { label: string; c: string }> = {
  healthy: { label: 'healthy', c: 'c-ok' },
  missing_hooks: { label: 'missing hooks', c: 'c-critical' },
  not_installed: { label: 'not installed', c: 'c-critical' },
  stale: { label: 'stale', c: 'c-warn' },
  no_events: { label: 'no events yet', c: 'c-dim' },
};

interface GovernanceViewProps {
  onRunOnboarding: () => void;
  onSelect: (id: string) => void;
}

/** Markup mirrors the demo's Governance page (demo-variants/src/variants/forest/pages-b.tsx). */
export function GovernanceView({ onRunOnboarding, onSelect }: GovernanceViewProps) {
  const { data: health } = usePolling<Health>(['health'], () => getHealth(), 10000);
  const { data: hookStatus, error: hookError } = usePolling<HookStatus>(['hookStatus'], () => getHookStatus(), 10000);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [r, setR] = useState<RetentionStatus | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);
  const [cleanup, setCleanup] = useState<RetentionCleanupResult | null>(null);

  useEffect(() => {
    let live = true;
    getSettings().then((s) => live && setSettings(s)).catch(() => {});
    Promise.all([getRetention(), getSelfAudit(100)])
      .then(([ret, a]) => {
        if (!live) return;
        setR(ret);
        setAudit(a);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const refresh = async () => {
    const [ret, a] = await Promise.all([getRetention(), getSelfAudit(100)]);
    setR(ret);
    setAudit(a);
  };
  const setPolicy = async (patch: { enabled?: boolean; days?: number }) => {
    if (!r) return;
    const before = r;
    setR({ ...r, policy: { ...r.policy, ...patch } });
    setBusy(true);
    try {
      setR(await updateRetention(patch));
      setAudit(await getSelfAudit(100));
    } catch {
      setR(before);
    } finally {
      setBusy(false);
    }
  };
  const runCleanup = async (dryRun: boolean) => {
    if (!dryRun && !window.confirm('Delete sessions older than the retention window?')) return;
    setBusy(true);
    try {
      setCleanup(await cleanupRetention(dryRun));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const hooks = hookStatus?.agents ?? [];
  const m = hookMatrix(hooks);
  const complete = hooks.filter((h) => h.missing_hooks.length === 0 && h.installed).length;
  const repair = hooks.some((h) => h.health === 'missing_hooks' || h.health === 'not_installed');

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div><span className="label">Govern</span><h1>Governance</h1><p>Coverage, where the data lives, how long it stays, and who touched it.</p></div>
          <a className="vbtn vbtn-quiet vbtn-sm" href="https://cot.run/pricing" target="_blank" rel="noreferrer">Enterprise plan <Icon name="external" size={14} /></a>
        </div>

        <section className="card" aria-labelledby="vf-cov" style={{ overflow: 'hidden' }}>
          <div className="card-h">
            <span className="card-t" id="vf-cov">Hook coverage</span>
            {hookStatus && <span className={`vchip ${complete === hooks.length ? 'c-ok' : 'c-warn'}`}><span className="dot" />{complete} of {hooks.length} agents complete</span>}
          </div>
          <div className="card-b" style={{ overflowX: 'auto' }}>
            {hookError ? (
              <p className="dim" style={{ margin: 0 }}>Hook status is unavailable while the collector is offline.</p>
            ) : !hookStatus ? (
              <p className="dim" style={{ margin: 0 }}>Checking hook status…</p>
            ) : (
              <>
                <div className="matrix" style={{ gridTemplateColumns: `130px repeat(${m.cols.length}, minmax(30px, 1fr))`, minWidth: 760 }}>
                  <span />
                  {m.cols.map((h) => <span key={h} className="mono faint" style={{ fontSize: 10, writingMode: 'vertical-rl', transform: 'rotate(180deg)', justifySelf: 'center', height: 122 }}>{h}</span>)}
                  {m.rows.map((a) => <MatrixRow key={a.source} name={<Agent id={a.source} />} cells={a.cells} />)}
                </div>
                <p className="faint" style={{ fontSize: 12, margin: '14px 0 0' }}>A dot means that agent has no such hook.{repair ? '' : ' Every hook each agent offers is installed.'}</p>
              </>
            )}
          </div>
          {hookStatus && (
            <>
              {hooks.map((h) => (
                <div key={h.source} style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--v-line)' }}>
                  <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Agent id={h.source} /><span className={`vchip ${HOOK_HEALTH[h.health].c}`}><span className="dot" />{HOOK_HEALTH[h.health].label}</span></span>
                    <span className="mono faint truncate" style={{ fontSize: 11 }} title={h.config_path ?? ''}>
                      {h.config_path ? homePath(h.config_path) : 'no config file'}
                      {h.latest_backup ? ` · backup ${fmt.day(h.latest_backup.created_at)}` : ''}
                      {h.missing_labels.length ? ` · missing ${h.missing_labels.slice(0, 3).join(', ')}${h.missing_labels.length > 3 ? ` +${h.missing_labels.length - 3}` : ''}` : ''}
                    </span>
                  </div>
                  <span className="mono dim" style={{ fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {h.installed_hooks.length}/{h.expected_hooks.length} hooks<br />
                    <span className="faint">{h.last_event ? `last event ${fmt.ago(h.last_event, new Date().toISOString())}` : 'no events yet'}</span>
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px 14px', borderTop: '1px solid var(--v-line)' }}>
                <span className="mono faint" style={{ fontSize: 11 }}>{hookStatus.updated_at ? `Updated ${fmt.ago(hookStatus.updated_at, new Date().toISOString())} · ` : ''}{hookStatus.manifest_found ? 'bridge manifest found' : 'using event history'}</span>
                <button type="button" className={`vbtn ${repair ? 'vbtn-primary' : 'vbtn-quiet'} vbtn-sm`} style={{ marginLeft: 'auto' }} onClick={onRunOnboarding}>{repair ? 'Reconfigure cot' : 'Run setup wizard'}</button>
              </div>
            </>
          )}
        </section>

        <div className="grid-2e">
          <section className="card">
            <div className="card-h"><span className="card-t">Data residency</span><span className="vchip c-ok">local only</span></div>
            <dl className="card-b" style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 16px', fontSize: 13 }}>
              <dt className="dim">Collector</dt><dd className="mono" style={{ margin: 0 }}>localhost:31337{health ? ` · v${health.version}` : ''}</dd>
              <dt className="dim">Database</dt><dd className="mono truncate" style={{ margin: 0 }} title={health?.db_path}>{health ? homePath(health.db_path) : '—'}{r ? ` · ${fmt.bytes(r.db_size_bytes)}` : ''}</dd>
              <dt className="dim">Oldest event</dt><dd className="mono" style={{ margin: 0 }}>{r?.oldest_event ? fmt.day(r.oldest_event) : '—'}</dd>
              <dt className="dim">Outbound</dt>
              <dd style={{ margin: 0 }}>
                {!settings ? '—' : settings.telemetry_env_disabled ? 'None. Usage metrics disabled by environment.' : settings.telemetry_enabled ? <>Anonymous usage metrics on. <a href="#/settings">Change</a></> : 'None. Usage metrics off.'}
                {settings?.ai_configured && !settings.ai_env_disabled ? ' AI analysis runs only when you ask.' : ''}
              </dd>
            </dl>
          </section>
          <section className="card">
            <div className="card-h"><span className="card-t">Retention</span><span className={`vchip ${r?.policy.enabled ? 'c-ok' : 'c-dim'}`}>{r ? (r.policy.enabled ? 'on' : 'off') : '…'}</span></div>
            <div className="card-b" style={{ display: 'grid', gap: 12 }}>
              {r ? (
                <p style={{ margin: 0 }}>
                  Keep traces for <b>{r.policy.days} days</b>.{' '}
                  {r.policy.enabled ? (
                    <>Sessions older than {fmt.day(r.cutoff)} are removed automatically.</>
                  ) : (
                    <>Turning it on now would remove <b className="tnum">{fmt.n(r.preview_sessions)}</b> sessions and <b className="tnum">{fmt.n(r.preview_events)}</b> events older than {fmt.day(r.cutoff)}.</>
                  )}
                </p>
              ) : (
                <p className="dim" style={{ margin: 0 }}>Loading…</p>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className={`vbtn ${r?.policy.enabled ? 'vbtn-quiet' : 'vbtn-primary'} vbtn-sm`} disabled={!r || busy} onClick={() => setPolicy({ enabled: !r?.policy.enabled })}>
                  {r?.policy.enabled ? 'Pause retention' : 'Turn on retention'}
                </button>
                <button type="button" className="vbtn vbtn-quiet vbtn-sm" disabled={!r} aria-expanded={windowOpen} onClick={() => setWindowOpen((o) => !o)}>Change window</button>
                <button type="button" className="vbtn vbtn-ghost vbtn-sm" disabled={!r || busy} onClick={() => runCleanup(true)}>Dry run</button>
                {r?.policy.enabled && <button type="button" className="vbtn vbtn-ghost vbtn-sm" style={{ color: 'var(--v-alert)' }} disabled={busy} onClick={() => runCleanup(false)}>Clean now</button>}
              </div>
              {windowOpen && r && <Seg id="vf-retwin" value={r.policy.days} onChange={(d) => setPolicy({ days: d })} options={[7, 30, 90, 180].map((d) => ({ k: d, l: `${d}d` }))} />}
              {cleanup && (
                <p className="dim" style={{ margin: 0, fontSize: 13 }}>
                  {cleanup.dry_run ? 'Dry run found' : 'Removed'} {fmt.n(cleanup.dry_run ? cleanup.eligible_events : cleanup.deleted_events)} events in{' '}
                  {fmt.n(cleanup.dry_run ? cleanup.eligible_sessions : cleanup.deleted_sessions)} sessions
                  {!cleanup.dry_run && cleanup.reclaimed_bytes > 0 ? `, reclaimed ${fmt.bytes(cleanup.reclaimed_bytes)}` : ''}.
                </p>
              )}
            </div>
          </section>
        </div>

        <section className="card" style={{ marginTop: 16, overflow: 'hidden' }}>
          <div className="card-h" style={{ paddingBottom: 12 }}><span className="card-t">Audit log</span><span className="label">{audit.length} entries</span></div>
          {audit.length === 0 ? (
            <div className="empty">No cot config events recorded yet.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="t">
                <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Target</th><th>Status</th></tr></thead>
                <tbody>
                  {audit.map((e) => (
                    <tr key={e.id}>
                      <td className="mono dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmt.dayTime(e.ts)}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{e.action}</td>
                      <td>{e.actor}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {e.target && /^[0-9a-f-]{20,}$/i.test(e.target) ? (
                          <a href="#/sessions" onClick={(ev) => { ev.preventDefault(); onSelect(e.target!); }}>{shortId(e.target)}</a>
                        ) : (
                          <span className="truncate" style={{ display: 'block', maxWidth: 220 }} title={e.target ?? ''}>{e.target ? <u>{e.target}</u> : '—'}</span>
                        )}
                      </td>
                      <td><span className={`vchip ${e.status === 'error' ? 'c-critical' : e.status === 'dry_run' ? 'c-info' : 'c-ok'}`}>{e.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section style={{ marginTop: 28 }}>
          <span className="label">Enterprise plan</span>
          <h2 style={{ margin: '6px 0 14px', fontSize: 18, letterSpacing: '-0.01em' }}>Org-wide controls</h2>
          <motion.div variants={listParent} initial={false} animate="show" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
            {ENTERPRISE.map((c) => (
              <motion.div key={c.k} variants={listItem} className="lockcard">
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}><Icon name="lock" size={14} style={{ color: 'var(--v-faint)' }} />{c.k}</span>
                <span className="dim" style={{ fontSize: 13 }}>{c.body}</span>
              </motion.div>
            ))}
          </motion.div>
        </section>
      </div>
    </div>
  );
}

function MatrixRow({ name, cells }: { name: ReactNode; cells: ('on' | 'miss' | 'na')[] }) {
  return (
    <>
      <span style={{ alignSelf: 'center' }}>{name}</span>
      {cells.map((c, i) => (
        <span
          key={i}
          className="cell"
          style={{ background: c === 'on' ? 'color-mix(in srgb, var(--v-olive) 18%, transparent)' : c === 'miss' ? 'color-mix(in srgb, var(--v-alert) 14%, transparent)' : 'var(--v-panel)', color: c === 'on' ? 'var(--v-olive)' : c === 'miss' ? 'var(--v-alert)' : 'var(--v-faint)' }}
          title={c === 'on' ? 'Installed' : c === 'miss' ? 'Missing' : 'Not applicable'}>
          {c === 'on' ? <Icon name="check" size={12} /> : c === 'miss' ? '!' : '·'}
        </span>
      ))}
    </>
  );
}

/** Agents × hook events. Names are matched case-insensitively (Cursor uses camelCase). */
function hookMatrix(hooks: HookStatusAgent[]) {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const a of hooks)
    for (const h of a.expected_hooks) {
      const k = h.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(h[0].toUpperCase() + h.slice(1));
      }
    }
  const rows = hooks.map((a) => {
    const exp = new Set(a.expected_hooks.map((h) => h.toLowerCase()));
    const inst = new Set(a.installed_hooks.map((h) => h.toLowerCase()));
    return { source: a.source, cells: cols.map((c) => { const k = c.toLowerCase(); return inst.has(k) ? ('on' as const) : exp.has(k) ? ('miss' as const) : ('na' as const); }) };
  });
  return { cols, rows };
}

export function needsHookRepair(agent: HookStatusAgent): boolean {
  return agent.health === 'missing_hooks' || agent.health === 'not_installed';
}

export function homePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/root/, '~');
}

export const shortPath = homePath;
