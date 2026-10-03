import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  cleanupRetention,
  getHealth,
  getHookStatus,
  getRetention,
  getSettings,
  getPassive,
  getVersionInfo,
  runPassiveNow,
  updatePassive,
  runAiAnalysis,
  updateRetention,
  updateSettings,
  type AiProvider,
  type Health,
  type HookHealthState,
  type HookStatus,
  PassiveUnsupportedError,
  type PassiveAgent,
  type PassiveStatus,
  type RetentionCleanupResult,
  type RetentionStatus,
  type Settings,
  type VersionInfo,
} from '../../lib/api';
import { setPref, usePrefs, type Prefs } from '../../lib/prefs';
import { useTheme } from '../../lib/theme';
import { usePolling } from '../../lib/usePolling';
import { fmt } from '../forest/format';
import { Icon } from '../forest/icons';
import { Agent, Seg, Switch } from '../forest/ui';
import { MarkPicker } from '../forest/MarkPicker';
import { ExportModal } from './ExportModal';
import { AgentSources, HooksGap, RunStatus, SchedulePicker } from '../passive/PassiveParts';
import { homePath } from './GovernanceView';

interface SettingsViewProps {
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  navCollapsed: boolean;
  onNavCollapsedChange: (collapsed: boolean) => void;
  onRunOnboarding: () => void;
}

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'defaults', label: 'Defaults', icon: 'overview' },
  { id: 'ai', label: 'AI insights', icon: 'sparkle' },
  { id: 'collector', label: 'Collector & hooks', icon: 'plug' },
  { id: 'passive', label: 'Passive import', icon: 'clock' },
  { id: 'privacy', label: 'Privacy', icon: 'lock' },
  { id: 'data', label: 'Data & retention', icon: 'database' },
];

const HOOK_HEALTH: Record<HookHealthState, { label: string; c: string }> = {
  healthy: { label: 'healthy', c: 'c-ok' },
  missing_hooks: { label: 'missing hooks', c: 'c-critical' },
  not_installed: { label: 'not installed', c: 'c-critical' },
  stale: { label: 'stale', c: 'c-warn' },
  no_events: { label: 'no events yet', c: 'c-dim' },
};

/** Markup mirrors the demo's Settings page (demo-variants/src/variants/forest/settings.tsx); every control writes for real. */
export function SettingsView({ sidebarOpen, onSidebarOpenChange, navCollapsed, onNavCollapsedChange, onRunOnboarding }: SettingsViewProps) {
  const prefs = usePrefs();
  const { preference, setPreference } = useTheme();
  const [section, setSection] = useScrollSpy();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    getSettings().then(setSettings).catch(() => {});
  }, []);

  const pref = <K extends keyof Prefs>(k: K) => (v: Prefs[K]) => setPref(k, v);

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div><span className="label">Workspace</span><h1>Settings</h1><p>Display, AI, collector and data. Your traces stay on your machine.</p></div>
        </div>
        <div className="set">
          <nav className="set-nav" aria-label="Settings sections">
            {SECTIONS.map((x) => (
              <a
                key={x.id}
                href="#/settings"
                className="nav-i"
                aria-current={section === x.id ? 'true' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  setSection(x.id);
                  document.getElementById(`set-${x.id}`)?.scrollIntoView({ block: 'start' });
                }}>
                <Icon name={x.icon} />
                <span>{x.label}</span>
              </a>
            ))}
          </nav>

          <div className="set-body">
            <Section id="appearance" title="Appearance" desc="How the dashboard looks on this browser.">
              <Row label="Theme" hint="Light is the default. System follows your OS setting.">
                <Seg
                  id="set-theme"
                  label="Theme"
                  value={preference}
                  onChange={setPreference}
                  options={[
                    { k: 'light', l: <Icon name="sun" size={16} />, name: 'Light' },
                    { k: 'dark', l: <Icon name="moon" size={16} />, name: 'Dark' },
                    { k: 'system', l: <Icon name="monitor" size={16} />, name: 'System' },
                  ]}
                />
              </Row>
              <Row label="Density" hint="Compact fits more rows into tables and traces.">
                <Seg id="set-density" value={prefs.density} onChange={pref('density')} options={[{ k: 'comfortable', l: 'Comfortable' }, { k: 'compact', l: 'Compact' }]} />
              </Row>
              <Row label="Sidebar" hint="The rail keeps icons only, with names on hover.">
                <Seg id="set-rail" value={navCollapsed ? 'rail' : 'full'} onChange={(v) => onNavCollapsedChange(v === 'rail')} options={[{ k: 'full', l: 'Expanded' }, { k: 'rail', l: 'Rail' }]} />
              </Row>
              <Row label="Session list" hint="Whether the session list stays open beside a session's trace.">
                <Seg id="set-sesslist" value={sidebarOpen ? 'open' : 'closed'} onChange={(v) => onSidebarOpenChange(v === 'open')} options={[{ k: 'open', l: 'Open' }, { k: 'closed', l: 'Collapsed' }]} />
              </Row>
              <Row label="Workspace mark" hint="The image beside the workspace name in the sidebar. Saved on this browser.">
                <MarkPicker value={prefs.avatar} initial="L" onChange={(v) => setPref('avatar', v)} />
              </Row>
              <Row label="Motion" hint="Reduced keeps fades and drops movement, whatever the OS says.">
                <Seg id="set-motion" value={prefs.motion} onChange={pref('motion')} options={[{ k: 'system', l: 'System' }, { k: 'reduced', l: 'Reduced' }]} />
              </Row>
            </Section>

            <Section id="defaults" title="Defaults" desc="Where the dashboard opens and what it shows first.">
              <Row label="Start page" hint="Opened when you visit the dashboard root.">
                <Seg id="set-start" value={prefs.start} onChange={pref('start')} options={[{ k: 'overview', l: 'Overview' }, { k: 'sessions', l: 'Sessions' }, { k: 'findings', l: 'Findings' }]} />
              </Row>
              <Row label="Overview range" hint="Used until you pick another range on the page.">
                <Seg id="set-range" value={prefs.range} onChange={pref('range')} options={[{ k: 7, l: '7d' }, { k: 30, l: '30d' }, { k: 90, l: '90d' }]} />
              </Row>
            </Section>

            <AiSection settings={settings} onSettings={setSettings} />
            <CollectorSection onRunOnboarding={onRunOnboarding} />
            <PassiveSection />
            <PrivacySection settings={settings} onSettings={setSettings} />
            <DataSection onExport={() => setExportOpen(true)} />
          </div>
        </div>
      </div>
      {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}
    </div>
  );
}

function AiSection({ settings: s, onSettings }: { settings: Settings | null; onSettings: (s: Settings) => void }) {
  const [model, setModel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  // The key is write-only: typed here, sent once, never read back or stored in the browser.
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!s) return;
    setModel(s.ai_model ?? '');
    setEndpoint(s.ai_endpoint ?? '');
  }, [s?.ai_model, s?.ai_endpoint]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = async (p: Parameters<typeof updateSettings>[0], done: string) => {
    setBusy(true);
    setNote(null);
    try {
      onSettings(await updateSettings(p));
      setNote({ ok: true, text: done });
      return true;
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const dirty = !!s && (!!key.trim() || model.trim() !== (s.ai_model ?? '') || endpoint.trim() !== (s.ai_endpoint ?? ''));
  const save = async () => {
    const p: Parameters<typeof updateSettings>[0] = { ai_model: model.trim(), ai_endpoint: endpoint.trim() };
    if (key.trim()) p.ai_api_key = key.trim();
    if (await patch(p, 'Saved.')) {
      setKey('');
      setShow(false);
    }
  };
  const removeKey = async () => {
    if (!window.confirm('Remove the saved API key? AI analysis stops until you add one again.')) return;
    await patch({ ai_api_key: '' }, 'Key removed.');
  };
  const run = async () => {
    if (!window.confirm('Run an AI analysis now? Findings, metrics and masked excerpts from the last 30 days are sent to your provider.')) return;
    setBusy(true);
    setNote(null);
    try {
      const a = await runAiAnalysis(30);
      setNote(a.status === 'ok' ? { ok: true, text: 'Analysis saved. It leads the executive summary on the Overview.' } : { ok: false, text: a.error ?? 'The analysis failed.' });
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const provider: AiProvider = s?.ai_provider ?? 'anthropic';
  const disabled = !s || s.ai_env_disabled;
  return (
    <Section id="ai" title="AI insights" desc="Bring your own key for AI analysis. It runs only when you ask; findings, metrics and masked excerpts go to your provider. The key stays in ~/.cot.">
      <div className="set-status" data-on={!!s?.ai_configured}>
        <Icon name={s?.ai_configured ? 'check' : 'sparkle'} size={16} />
        <div style={{ minWidth: 0 }}>
          <b>{!s ? 'Loading…' : s.ai_env_disabled ? 'Disabled on this install' : s.ai_configured ? 'Connection configured' : 'Not configured'}</b>
          {s && (
            <span className="mono dim truncate" style={{ display: 'block', fontSize: 12 }} title={s.ai_effective_endpoint}>
              {provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'} · {s.ai_model || s.ai_default_model} · {s.ai_effective_endpoint}
            </span>
          )}
        </div>
        {s?.ai_configured && <span className="vchip c-dim" style={{ marginLeft: 'auto' }}>key from {s.ai_key_source === 'env' ? 'env' : '~/.cot'}</span>}
      </div>
      <fieldset disabled={disabled} className="set-fs">
        <Row label="Provider" hint="OpenAI-compatible covers OpenRouter, Azure and local gateways.">
          <Seg id="set-prov" value={provider} onChange={(v) => v !== provider && void patch({ ai_provider: v }, 'Provider saved.')} options={[{ k: 'anthropic', l: 'Anthropic' }, { k: 'openai', l: 'OpenAI-compatible' }]} />
        </Row>
        <Row label="API key" hint={s?.ai_configured ? `Saved ${s.ai_key_masked ?? ''}. Paste a new one to replace it.` : 'Write-only. cot never sends it back to the browser.'}>
          <div className="input-wrap">
            <input className="input mono" type={show ? 'text' : 'password'} value={key} onChange={(e) => setKey(e.target.value)} placeholder={s?.ai_configured ? '•••• saved' : provider === 'openai' ? 'sk-…' : 'sk-ant-…'} autoComplete="off" spellCheck={false} aria-label="API key" />
            <button type="button" className="iconbtn" style={{ width: 28, height: 28 }} onClick={() => setShow((x) => !x)} aria-label={show ? 'Hide key' : 'Show key'} aria-pressed={show} disabled={!key}><Icon name="eye" size={15} /></button>
          </div>
        </Row>
        <Row label="Model" hint={`Optional. Default is ${s?.ai_default_model ?? '…'}.`}>
          <input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder={s?.ai_default_model} aria-label="Model" spellCheck={false} />
        </Row>
        <Row label="Endpoint" hint="Optional. Leave empty for the provider default." wide>
          <input className="input mono" style={{ width: '100%' }} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={s?.ai_default_endpoint} aria-label="Endpoint" spellCheck={false} />
        </Row>
        <div className="set-actions">
          {note && <span style={{ marginRight: 'auto', alignSelf: 'center', fontSize: 13, color: note.ok ? 'var(--v-olive)' : 'var(--v-alert)' }}>{note.text}</span>}
          {s?.ai_configured && s.ai_key_source === 'db' && <button type="button" className="vbtn vbtn-ghost vbtn-sm" style={{ color: 'var(--v-alert)' }} disabled={busy} onClick={removeKey}>Remove key</button>}
          <button type="button" className="vbtn vbtn-quiet vbtn-sm" disabled={busy || !s?.ai_configured || dirty} onClick={run}>Run analysis</button>
          <button type="button" className="vbtn vbtn-primary vbtn-sm" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </fieldset>
    </Section>
  );
}

function CollectorSection({ onRunOnboarding }: { onRunOnboarding: () => void }) {
  const { data: health, error } = usePolling<Health>(['health'], () => getHealth(), 10000);
  const { data: hooks } = usePolling<HookStatus>(['hookStatus'], () => getHookStatus(), 10000);
  const [r, setR] = useState<RetentionStatus | null>(null);
  const [v, setV] = useState<VersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  useEffect(() => {
    getRetention().then(setR).catch(() => {});
    getVersionInfo().then(setV).catch(() => {});
  }, []);
  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const d = await getVersionInfo(true);
      setV(d);
      if (!d.latest) setCheckError('Update check unavailable: offline or disabled.');
    } catch {
      setCheckError('Could not reach the collector.');
    } finally {
      setChecking(false);
    }
  };
  const now = new Date().toISOString();
  return (
    <Section id="collector" title="Collector & hooks" desc="The local API that receives agent events, and the hooks that feed it.">
      <dl className="set-facts">
        <div><dt className="label">Status</dt><dd><span className="live" style={{ display: 'inline-block', marginRight: 8, ...(error ? { background: 'var(--v-alert)' } : {}) }} />{error ? 'offline' : health?.status === 'ok' ? 'online' : '…'}</dd></div>
        <div><dt className="label">Version</dt><dd className="mono">{health?.version ?? '—'}</dd></div>
        <div><dt className="label">Address</dt><dd className="mono">localhost:31337</dd></div>
        <div><dt className="label">Database</dt><dd className="mono" title={health?.db_path}>{health ? homePath(health.db_path) : '—'}{r ? ` · ${fmt.bytes(r.db_size_bytes)}` : ''}</dd></div>
      </dl>
      <ul className="set-list">
        {(hooks?.agents ?? []).map((h) => (
          <li key={h.source}>
            <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Agent id={h.source} /><span className={`vchip ${HOOK_HEALTH[h.health].c}`}><span className="dot" />{HOOK_HEALTH[h.health].label}</span></span>
              <span className="mono faint truncate" style={{ fontSize: 11 }} title={h.config_path ?? ''}>{h.config_path ? homePath(h.config_path) : 'no config file'}</span>
            </div>
            <span className="mono dim" style={{ fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
              {h.installed_hooks.length}/{h.expected_hooks.length} hooks<br /><span className="faint">{h.last_event ? `last event ${fmt.ago(h.last_event, now)}` : 'no events yet'}</span>
            </span>
          </li>
        ))}
        {!hooks && <li className="dim" style={{ fontSize: 13 }}>Checking hook status…</li>}
      </ul>
      <Row label="Setup wizard" hint="Re-run onboarding to switch agents or re-verify hooks.">
        <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={onRunOnboarding}>Run setup</button>
      </Row>
      <Row
        label="Updates"
        hint={checking ? 'Checking…' : checkError ? checkError : v?.latest ? (v.update_available ? `Update available: v${v.latest}.` : `Up to date. Latest is v${v.latest}.`) : 'Check whether a newer release is available.'}>
        {v?.update_available && v.url && <a className="vbtn vbtn-ghost vbtn-sm" href={v.url} target="_blank" rel="noreferrer">Instructions <Icon name="external" size={14} /></a>}
        <button type="button" className="vbtn vbtn-quiet vbtn-sm" disabled={checking || error} onClick={check}>Check for updates</button>
      </Row>
    </Section>
  );
}

function PrivacySection({ settings: s, onSettings }: { settings: Settings | null; onSettings: (s: Settings) => void }) {
  const locked = !s || s.telemetry_env_disabled;
  const setOn = async (on: boolean) => {
    if (!s) return;
    onSettings({ ...s, telemetry_enabled: on });
    try {
      onSettings(await updateSettings({ telemetry_enabled: on }));
    } catch {
      onSettings({ ...s, telemetry_enabled: !on });
    }
  };
  return (
    <Section id="privacy" title="Privacy" desc="What, if anything, leaves this machine.">
      <Row
        label="Usage metrics"
        hint={s?.telemetry_env_disabled ? 'Turned off for this install by COT_DISABLE_TELEMETRY.' : `Anonymous totals (sessions, events, models, error rate) sent to ${s?.telemetry_endpoint ?? 'cot.run'}. No traces, prompts, paths or code.`}>
        <Switch on={!!s?.telemetry_enabled} disabled={locked} label="Usage metrics" onChange={(v) => void setOn(v)} />
      </Row>
      <Row label="AI analysis" hint="Sends findings and masked excerpts to your provider, only when you run it.">
        <a href="#/settings" className="vbtn vbtn-ghost vbtn-sm" onClick={(e) => { e.preventDefault(); document.getElementById('set-ai')?.scrollIntoView({ block: 'start' }); }}>
          {s?.ai_configured ? 'Configured' : 'Off'} <Icon name="arrow" size={14} />
        </a>
      </Row>
    </Section>
  );
}

function PassiveSection() {
  const [p, setP] = useState<PassiveStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gap, setGap] = useState(false);
  // 'unsupported': an older collector without passive mode; 'offline': the request failed.
  const [problem, setProblem] = useState<'unsupported' | 'offline' | null>(null);
  const running = !!p?.running.running;
  // Poll quickly while a pass runs so the phase moves on screen; slowly otherwise.
  useEffect(() => {
    let live = true;
    const load = () =>
      getPassive()
        .then((x) => {
          if (!live) return;
          setP(x);
          setProblem(null);
        })
        .catch((e) => live && setProblem(e instanceof PassiveUnsupportedError ? 'unsupported' : 'offline'));
    load();
    const t = window.setInterval(load, running ? 2000 : 15000);
    return () => { live = false; window.clearInterval(t); };
  }, [running]);
  const save = async (patch: Parameters<typeof updatePassive>[0]) => {
    setErr(null);
    try {
      setP(await updatePassive(patch));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const toggleAgent = (a: PassiveAgent, on: boolean) => {
    if (!p) return;
    void save({ agents: on ? [...p.agents, a] : p.agents.filter((x) => x !== a) });
  };
  const runNow = async () => {
    await runPassiveNow();
    setP(await getPassive());
  };
  return (
    <Section id="passive" title="Passive import" desc="Build sessions from agent transcripts on a schedule, with or without hooks. Each run imports metadata first, then runs analysis.">
      {problem && !p ? (
        <Row
          label="Passive mode"
          hint={
            problem === 'unsupported'
              ? "This collector doesn't support passive import yet. Update the cot app to turn it on."
              : "Couldn't reach the collector. It will retry automatically."
          }>
          <span className={`vchip ${problem === 'unsupported' ? 'c-dim' : 'c-warn'}`}>{problem === 'unsupported' ? 'needs update' : 'offline'}</span>
        </Row>
      ) : (
      <>
      <Row
        label="Passive mode"
        hint={!p ? 'Loading…' : p.enabled ? `On. ${p.schedule.description}${p.next_scheduled ? `, next at ${fmt.dayTime(p.next_scheduled)}` : ''}.` : 'Off. Turn it on to import transcripts on a schedule.'}>
        <Switch on={!!p?.enabled} disabled={!p} label="Passive mode" onChange={(v) => void save({ enabled: v })} />
      </Row>
      <Row label="Agents" hint="Transcripts found on this machine. Only switched-on agents are imported." stack>
        {p && <AgentSources detail={p.agents_detail} enabled={p.agents} onToggle={toggleAgent} />}
      </Row>
      <Row label="Schedule" hint="Pick a plain-English schedule or write your own cron." stack>
        {p && <SchedulePicker value={p.cron} presets={p.presets} onChange={(c) => void save({ cron: c })} />}
      </Row>
      {err && <p role="alert" className="mono" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--v-alert)' }}>{err}</p>}
      <Row label="Last run" hint={running ? undefined : 'Runs also start on the schedule while passive mode is on.'} stack>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          {p && <RunStatus status={p} />}
          <button type="button" className="vbtn vbtn-quiet vbtn-sm" disabled={!p || running || p.agents.length === 0} onClick={() => void runNow()}>
            <Icon name="bolt" size={14} />{running ? 'Running…' : 'Run now'}
          </button>
        </div>
      </Row>
      <Row label="Without hooks" hint="What transcripts alone can't show.">
        <button type="button" className="vbtn vbtn-ghost vbtn-sm" aria-expanded={gap} aria-controls="set-hooks-gap" onClick={() => setGap((g) => !g)}>
          {gap ? 'Hide' : 'Show'} what you don't get <Icon name="down" size={14} style={{ transform: gap ? 'rotate(180deg)' : undefined }} />
        </button>
      </Row>
      {/* Opens under the row at full width, so the list reads like the rest of the section. */}
      {gap && <div id="set-hooks-gap" style={{ padding: '4px 0 14px' }}><HooksGap /></div>}
      </>
      )}
    </Section>
  );
}

const WINDOWS = [7, 30, 90, 180].map((d) => ({ k: d, l: `${d}d` }));

function DataSection({ onExport }: { onExport: () => void }) {
  const [r, setR] = useState<RetentionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RetentionCleanupResult | null>(null);
  useEffect(() => {
    getRetention().then(setR).catch(() => {});
  }, []);
  const set = async (p: { enabled?: boolean; days?: number }) => {
    if (!r) return;
    const before = r;
    setR({ ...r, policy: { ...r.policy, ...p } });
    try {
      setR(await updateRetention(p));
    } catch {
      setR(before);
    }
  };
  const clean = async (dryRun: boolean) => {
    if (!dryRun && !window.confirm('Delete sessions older than the retention window?')) return;
    setBusy(true);
    try {
      setResult(await cleanupRetention(dryRun));
      setR(await getRetention());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section id="data" title="Data & retention" desc="Local cleanup, exports and this browser's preferences.">
      <Row label="Retention" hint={!r ? 'Loading…' : r.policy.enabled ? `Sessions older than ${r.policy.days} days are removed automatically.` : `Paused. The database is ${fmt.bytes(r.db_size_bytes)} and keeps growing.`}>
        <Switch on={!!r?.policy.enabled} disabled={!r} label="Retention" onChange={(v) => void set({ enabled: v })} />
      </Row>
      <Row label="Window" hint={r ? `A ${r.policy.days}-day window would remove ${fmt.n(r.preview_sessions)} sessions and ${fmt.n(r.preview_events)} events.` : undefined}>
        <Seg id="set-ret" value={r?.policy.days ?? 30} onChange={(d) => void set({ days: d })} options={WINDOWS} />
      </Row>
      <Row
        label="Clean up"
        hint={result ? `${result.dry_run ? 'Dry run found' : 'Removed'} ${fmt.n(result.dry_run ? result.eligible_events : result.deleted_events)} events in ${fmt.n(result.dry_run ? result.eligible_sessions : result.deleted_sessions)} sessions${!result.dry_run && result.reclaimed_bytes > 0 ? `, reclaimed ${fmt.bytes(result.reclaimed_bytes)}` : ''}.` : 'Preview what the window removes, or remove it now.'}>
        <button type="button" className="vbtn vbtn-quiet vbtn-sm" disabled={!r || busy} onClick={() => clean(true)}>Dry run</button>
        <button type="button" className="vbtn vbtn-ghost vbtn-sm" style={{ color: 'var(--v-alert)' }} disabled={!r?.policy.enabled || busy} onClick={() => clean(false)}>Clean now</button>
      </Row>
      <Row label="Export" hint="Sessions, audit log or metrics as JSON or CSV.">
        <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={onExport}><Icon name="download" size={14} />Export data</button>
      </Row>
      <Row label="Dashboard preferences" hint="Density, motion and defaults on this browser.">
        <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => { setPref('density', 'comfortable'); setPref('motion', 'system'); setPref('start', 'overview'); setPref('range', 30); }}>Reset to defaults</button>
      </Row>
    </Section>
  );
}

function Section({ id, title, desc, children }: { id: string; title: string; desc: string; children: ReactNode }) {
  return (
    <section className="card set-sec" id={`set-${id}`} aria-labelledby={`set-${id}-t`} data-spy={id}>
      <div className="set-h"><h2 id={`set-${id}-t`}>{title}</h2><p className="dim">{desc}</p></div>
      {children}
    </section>
  );
}

function Row({ label, hint, children, wide, stack }: { label: string; hint?: string; children: ReactNode; wide?: boolean; stack?: boolean }) {
  return (
    <div className="set-row" data-wide={wide} data-stack={stack || undefined}>
      <div style={{ minWidth: 0 }}><div className="set-l">{label}</div>{hint && <div className="set-hint">{hint}</div>}</div>
      <div className="set-c" style={{ gap: 8 }}>{children}</div>
    </div>
  );
}

/** Highlights the last section whose heading has reached the top of the scroll area (or the final one at the bottom).
 *  A click sets it directly and holds it until the jump settles, so the spy never flickers through sections in between. */
function useScrollSpy(): [string, (id: string) => void] {
  const [cur, setCur] = useState(SECTIONS[0].id);
  // A nav click pins its section until the reader scrolls on their own: the
  // short sections near the bottom can't reach the top, so position alone
  // would hand the click to the last section.
  const pinned = useRef(false);
  useEffect(() => {
    const root = document.getElementById('vf-scroll');
    if (!root) return;
    let raf = 0;
    const tick = () => {
      raf = 0;
      if (pinned.current) return;
      const els = [...root.querySelectorAll<HTMLElement>('[data-spy]')];
      const top = root.getBoundingClientRect().top;
      // The reading line sits near the top, then slides down over the last
      // screen of scroll so every section, however short, takes a turn.
      const left = root.scrollHeight - root.clientHeight - root.scrollTop;
      const reach = Math.min(root.clientHeight * 0.6, 360);
      const line = 96 + Math.max(0, 1 - left / reach) * (root.clientHeight - 96 - 48);
      const pick = els.filter((el) => el.getBoundingClientRect().top - top <= line).pop() ?? els[0];
      if (pick?.dataset.spy) setCur(pick.dataset.spy);
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(tick); };
    const unpin = () => { pinned.current = false; };
    root.addEventListener('scroll', on, { passive: true });
    root.addEventListener('wheel', unpin, { passive: true });
    root.addEventListener('touchmove', unpin, { passive: true });
    root.addEventListener('keydown', unpin);
    root.addEventListener('pointerdown', unpin);
    tick();
    return () => {
      root.removeEventListener('scroll', on);
      root.removeEventListener('wheel', unpin);
      root.removeEventListener('touchmove', unpin);
      root.removeEventListener('keydown', unpin);
      root.removeEventListener('pointerdown', unpin);
      cancelAnimationFrame(raf);
    };
  }, []);
  return [cur, (id) => { pinned.current = true; setCur(id); }];
}
