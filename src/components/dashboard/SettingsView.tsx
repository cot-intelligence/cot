import { useEffect, useState, type ReactNode } from 'react';
import { usePolling } from '../../lib/usePolling';
import {
  cleanupRetention,
  getHealth,
  getHookStatus,
  getRetention,
  getSettings,
  getSelfAudit,
  getVersionInfo,
  updateRetention,
  updateSettings,
  type AuditEvent,
  type Health,
  type HookHealthState,
  type HookStatus,
  type HookStatusAgent,
  type RetentionCleanupResult,
  type RetentionStatus,
  type Settings,
  type VersionInfo,
} from '../../lib/api';
import { formatRelative } from '../../lib/categoryMeta';
import { formatBytes } from '../../lib/format';
import { readSavedAgents } from '../../lib/settings';
import { sourceLabel } from '../../lib/sourceLabels';
import { useTheme } from '../../lib/theme';
import { FadeIn } from '../ui/FadeIn';
import { AgentMark } from '../ui/AgentMark';
import { ExportModal } from './ExportModal';

interface SettingsViewProps {
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  onRunOnboarding: () => void;
}

// Above this on-disk size, suggest enabling retention if it's paused. The local
// DB stores raw event payloads, so a busy machine can reach hundreds of MB.
const DB_SIZE_NUDGE_BYTES = 500 * 1024 * 1024;

export function SettingsView({
  sidebarOpen,
  onSidebarOpenChange,
  onRunOnboarding,
}: SettingsViewProps) {
  const { theme, setTheme } = useTheme();
  const { data: health, error: healthError } = usePolling<Health>(['health'], () => getHealth(), 10000);
  const { data: hookStatus, error: hookStatusError } = usePolling<HookStatus>(['hookStatus'], () => getHookStatus(), 10000);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [versionChecking, setVersionChecking] = useState(false);
  const [versionCheckError, setVersionCheckError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [retention, setRetention] = useState<RetentionStatus | null>(null);
  const [cleanupResult, setCleanupResult] = useState<RetentionCleanupResult | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [retentionBusy, setRetentionBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [aiKeyInput, setAiKeyInput] = useState('');
  const [aiModelInput, setAiModelInput] = useState('');
  const [aiEndpointInput, setAiEndpointInput] = useState('');
  const [aiConnectionOpen, setAiConnectionOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const savedAgents = readSavedAgents();

  useEffect(() => {
    let active = true;
    getVersionInfo()
      .then((data) => {
        if (active) setVersionInfo(data);
      })
      .catch(() => {
        /* offline — leave version info empty */
      });
    getSettings()
      .then((data) => {
        if (active) {
          setSettings(data);
          setAiModelInput(data.ai_model ?? '');
          setAiEndpointInput(data.ai_endpoint ?? '');
          setAiConnectionOpen(!data.ai_configured);
        }
      })
      .catch(() => {
        /* offline — leave settings empty */
      });
    Promise.all([getRetention(), getSelfAudit(8)])
      .then(([ret, audit]) => {
        if (active) {
          setRetention(ret);
          setAuditEvents(audit);
        }
      })
      .catch(() => {
        /* offline — leave retention/audit empty */
      });
    return () => {
      active = false;
    };
  }, []);

  const setTelemetry = async (enabled: boolean) => {
    if (!settings || settings.telemetry_env_disabled) return;
    setSettings({ ...settings, telemetry_enabled: enabled });
    try {
      const next = await updateSettings({ telemetry_enabled: enabled });
      setSettings(next);
    } catch {
      /* revert on failure */
      setSettings((s) => (s ? { ...s, telemetry_enabled: !enabled } : s));
    }
  };

  const refreshAudit = async () => {
    const [ret, audit] = await Promise.all([getRetention(), getSelfAudit(8)]);
    setRetention(ret);
    setAuditEvents(audit);
  };

  const patchAi = async (patch: Parameters<typeof updateSettings>[0]) => {
    setAiBusy(true);
    setAiError(null);
    try {
      const next = await updateSettings(patch);
      setSettings(next);
      return next;
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setAiBusy(false);
    }
  };

  const saveAiKey = async () => {
    const value = aiKeyInput.trim();
    if (!value) return;
    if (await patchAi({ ai_api_key: value })) setAiKeyInput('');
  };

  const saveAiModel = async () => {
    if (!settings) return;
    const value = aiModelInput.trim();
    if (value === (settings.ai_model ?? '')) return;
    const next = await patchAi({ ai_model: value });
    if (next) setAiModelInput(next.ai_model ?? '');
  };

  const saveAiEndpoint = async () => {
    if (!settings) return;
    const value = aiEndpointInput.trim();
    if (value === (settings.ai_endpoint ?? '')) return;
    const next = await patchAi({ ai_endpoint: value });
    if (next) setAiEndpointInput(next.ai_endpoint ?? '');
  };

  const saveAiConnection = async () => {
    if (!settings) return;
    const patch: Parameters<typeof updateSettings>[0] = {
      ai_model: aiModelInput.trim(),
      ai_endpoint: aiEndpointInput.trim(),
    };
    if (aiKeyInput.trim()) patch.ai_api_key = aiKeyInput.trim();
    const next = await patchAi(patch);
    if (next) {
      setAiKeyInput('');
      setAiModelInput(next.ai_model ?? '');
      setAiEndpointInput(next.ai_endpoint ?? '');
      setAiConnectionOpen(false);
    }
  };

  const setRetentionEnabled = async (enabled: boolean) => {
    if (!retention) return;
    setRetention({ ...retention, policy: { ...retention.policy, enabled } });
    try {
      const next = await updateRetention({ enabled });
      setRetention(next);
      setAuditEvents(await getSelfAudit(8));
    } catch {
      setRetention((r) => (r ? { ...r, policy: { ...r.policy, enabled: !enabled } } : r));
    }
  };

  const setRetentionDays = async (days: number) => {
    if (!retention) return;
    const before = retention.policy.days;
    setRetention({ ...retention, policy: { ...retention.policy, days } });
    try {
      const next = await updateRetention({ days });
      setRetention(next);
      setAuditEvents(await getSelfAudit(8));
    } catch {
      setRetention((r) => (r ? { ...r, policy: { ...r.policy, days: before } } : r));
    }
  };

  const runRetentionCleanup = async (dryRun: boolean) => {
    if (!dryRun && !window.confirm('Delete sessions older than the retention window?')) return;
    setRetentionBusy(true);
    try {
      const result = await cleanupRetention(dryRun);
      setCleanupResult(result);
      await refreshAudit();
    } finally {
      setRetentionBusy(false);
    }
  };

  const checkForUpdates = async () => {
    setVersionChecking(true);
    setVersionCheckError(null);
    try {
      const data = await getVersionInfo(true);
      setVersionInfo(data);
      if (!data.latest) {
        setVersionCheckError('Update check unavailable — offline or disabled.');
      }
    } catch {
      setVersionCheckError('Could not reach the collector to check for updates.');
    } finally {
      setVersionChecking(false);
    }
  };

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-10 px-6 py-8 sm:px-8">
        <FadeIn className="space-y-2">
          <h1 className="text-3xl font-extrabold uppercase tracking-tight text-fg">
            Settings
          </h1>
          <p className="font-mono text-xs text-fg/50">
            Collector and preferences. Your traces stay on your machine.
          </p>
        </FadeIn>

        <FadeIn delay={0.03}>
          <Section title="Collector" description="Local API that receives agent events.">
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Status"
                value={healthError ? 'Offline' : health?.status ?? '…'}
                accent={!healthError && health?.status === 'ok'}
                warn={healthError}
              />
              <Stat label="Version" value={health?.version ?? '—'} />
              <Stat
                label="Database"
                value={health ? shortPath(health.db_path) : '—'}
                hint={health?.db_path}
              />
            </div>
          </Section>
        </FadeIn>

        <FadeIn delay={0.05}>
          <Section
            title="Setup wizard"
            description="Step-by-step onboarding to pick an agent and verify your first trace.">
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-surface p-4 shadow-soft">
              <div className="space-y-1">
                <p className="font-mono text-sm font-bold text-fg">
                  {savedAgents.length > 0 ? 'Reconfigure cot' : 'Configure cot'}
                </p>
                <p className="font-mono text-xs text-fg/45">
                  Re-run the wizard to switch agents or re-verify setup.
                </p>
              </div>
              <button
                type="button"
                onClick={onRunOnboarding}
                className="shrink-0 border border-fg bg-fg px-5 py-2.5 font-mono text-[0.65rem] font-bold uppercase tracking-widest text-bg shadow-soft transition-opacity hover:opacity-90">
                Run setup wizard
              </button>
            </div>
          </Section>
        </FadeIn>

        <FadeIn delay={0.07}>
          <Section
            title="Hook health"
            description="Agent hook status and recent activity.">
            {hookStatusError ? (
              <p className="font-mono text-xs text-vermilion/70">
                Hook status is unavailable while the collector is offline.
              </p>
            ) : hookStatus ? (
              <>
                <ul className="divide-y divide-line/10 rounded-lg bg-surface shadow-soft">
                  {hookStatus.agents.map((agent) => (
                    <HookHealthRow
                      key={agent.source}
                      agent={agent}
                      onReconfigure={onRunOnboarding}
                    />
                  ))}
                </ul>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-mono text-[0.62rem] text-fg/40">
                    Updated {formatRelative(hookStatus.updated_at)} ·{' '}
                    {hookStatus.manifest_found ? 'bridge manifest found' : 'using event history'}
                  </p>
                  {hookStatus.agents.some((agent) => needsHookRepair(agent)) && (
                    <button
                      type="button"
                      onClick={onRunOnboarding}
                      className="border border-vermilion px-3 py-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-vermilion transition-colors hover:bg-vermilion hover:text-cream">
                      Reconfigure cot
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className="font-mono text-xs text-fg/40">Checking hook status…</p>
            )}
          </Section>
        </FadeIn>

        <FadeIn delay={0.13}>
          <Section title="Preferences" description="Dashboard display options.">
            <div className="space-y-4">
              <PreferenceRow label="Theme" hint="Light or dark interface.">
                <div className="flex gap-1 rounded-md bg-panel p-1">
                  {(['light', 'dark'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTheme(t)}
                      className={`rounded px-3 py-1.5 font-mono text-[0.65rem] font-bold uppercase tracking-widest transition-colors ${
                        theme === t ? 'bg-surface text-fg shadow-soft' : 'text-fg/45 hover:text-fg'
                      }`}>
                      {t}
                    </button>
                  ))}
                </div>
              </PreferenceRow>
              <PreferenceRow
                label="Session sidebar"
                hint="Default state when opening a session detail view.">
                <div className="flex gap-1 rounded-md bg-panel p-1">
                  <ToggleChip
                    label="Open"
                    active={sidebarOpen}
                    onClick={() => onSidebarOpenChange(true)}
                  />
                  <ToggleChip
                    label="Collapsed"
                    active={!sidebarOpen}
                    onClick={() => onSidebarOpenChange(false)}
                  />
                </div>
              </PreferenceRow>
              <PreferenceRow label="Usage metrics">
                <div className="flex gap-1 rounded-md bg-panel p-1">
                  <ToggleChip
                    label="On"
                    active={!!settings?.telemetry_enabled}
                    disabled={!settings || settings.telemetry_env_disabled}
                    onClick={() => setTelemetry(true)}
                  />
                  <ToggleChip
                    label="Off"
                    active={!!settings && !settings.telemetry_enabled}
                    disabled={!settings || settings.telemetry_env_disabled}
                    onClick={() => setTelemetry(false)}
                  />
                </div>
              </PreferenceRow>
            </div>
          </Section>
        </FadeIn>

        <FadeIn delay={0.125}>
          <Section
            title="AI insights"
            description="Bring your own key for AI analysis on the Overview page. Runs only when you ask; findings, metrics and masked excerpts are sent to your provider. The key stays local in ~/.cot.">
            <div className="space-y-4">
              {settings?.ai_env_disabled && (
                <p className="font-mono text-xs text-vermilion">
                  Disabled for this deployment via COT_DISABLE_LLM.
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface p-4 shadow-soft">
                <div className="min-w-0 space-y-1">
                  <p className="font-mono text-sm font-bold text-fg">
                    {settings?.ai_configured ? 'AI connection configured' : 'No AI connection'}
                  </p>
                  <p className="truncate font-mono text-xs text-fg/45" title={settings?.ai_effective_endpoint}>
                    {settings
                      ? `${settings.ai_provider === 'openai' ? 'OpenAI' : 'Anthropic'} · ${
                          settings.ai_model ?? settings.ai_default_model
                        } · ${settings.ai_effective_endpoint}`
                      : 'Loading connection state…'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAiConnectionOpen((open) => !open)}
                  disabled={!settings || settings.ai_env_disabled || aiBusy}
                  className="shrink-0 border border-fg/25 px-3 py-2 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-fg/75 shadow-soft transition-colors hover:border-vermilion hover:text-vermilion disabled:cursor-not-allowed disabled:opacity-40">
                  {aiConnectionOpen ? 'Hide form' : settings?.ai_configured ? 'Edit connection' : 'Add connection'}
                </button>
              </div>
              {aiConnectionOpen && (
                <div className="space-y-4 rounded-lg bg-surface p-4 shadow-soft">
              <PreferenceRow
                label="API key"
                hint={
                  settings?.ai_configured
                    ? `Configured ${settings.ai_key_masked ?? ''}${
                        settings.ai_key_source === 'env' ? ' — from environment variable' : ''
                      }`
                    : 'Not configured — analysis is disabled until you add one.'
                }>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    value={aiKeyInput}
                    onChange={(e) => setAiKeyInput(e.target.value)}
                    onBlur={() => void saveAiKey()}
                    placeholder={settings?.ai_provider === 'openai' ? 'sk-…' : 'sk-ant-…'}
                    autoComplete="off"
                    disabled={!settings || settings.ai_env_disabled}
                    className="w-52 rounded-md bg-panel px-3 py-1.5 font-mono text-xs text-fg placeholder:text-fg/30 focus:outline-none focus:ring-1 focus:ring-vermilion disabled:cursor-not-allowed disabled:opacity-40"
                  />
                </div>
              </PreferenceRow>
              <PreferenceRow
                label="Model"
                hint={`Optional override — default is ${settings?.ai_default_model ?? '…'}.`}>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={aiModelInput}
                    onChange={(e) => setAiModelInput(e.target.value)}
                    onBlur={() => void saveAiModel()}
                    placeholder={settings?.ai_default_model}
                    autoComplete="off"
                    disabled={!settings || settings.ai_env_disabled}
                    className="w-52 rounded-md bg-panel px-3 py-1.5 font-mono text-xs text-fg placeholder:text-fg/30 focus:outline-none focus:ring-1 focus:ring-vermilion disabled:cursor-not-allowed disabled:opacity-40"
                  />
                </div>
              </PreferenceRow>
              <PreferenceRow
                label="Endpoint"
                hint={`Optional override — default is ${settings?.ai_default_endpoint ?? '…'}.`}>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="url"
                    value={aiEndpointInput}
                    onChange={(e) => setAiEndpointInput(e.target.value)}
                    onBlur={() => void saveAiEndpoint()}
                    placeholder={settings?.ai_default_endpoint}
                    autoComplete="off"
                    disabled={!settings || settings.ai_env_disabled}
                    className="w-full min-w-[16rem] max-w-md rounded-md bg-panel px-3 py-1.5 font-mono text-xs text-fg placeholder:text-fg/30 focus:outline-none focus:ring-1 focus:ring-vermilion disabled:cursor-not-allowed disabled:opacity-40"
                  />
                </div>
              </PreferenceRow>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void saveAiConnection()}
                  disabled={
                    !settings ||
                    settings.ai_env_disabled ||
                    aiBusy ||
                    (!aiKeyInput.trim() &&
                      aiModelInput.trim() === (settings.ai_model ?? '') &&
                      aiEndpointInput.trim() === (settings.ai_endpoint ?? ''))
                  }
                  className="border border-fg bg-fg px-4 py-2 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-bg shadow-soft transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
                  Save connection
                </button>
              </div>
                </div>
              )}
              {aiError && <p className="font-mono text-xs text-vermilion">{aiError}</p>}
            </div>
          </Section>
        </FadeIn>

        <FadeIn delay={0.12}>
          <Section
            title="Data export"
            description="Export sessions, audit logs, or metrics to JSON or CSV.">
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-surface p-4 shadow-soft">
              <div className="space-y-1">
                <p className="font-mono text-sm font-bold text-fg">
                  Export your data
                </p>
                <p className="font-mono text-xs text-fg/45">
                  Filter by source, dates, models, tokens and more.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setExportOpen(true)}
                className="shrink-0 border border-fg bg-fg px-5 py-2.5 font-mono text-[0.65rem] font-bold uppercase tracking-widest text-bg shadow-soft transition-opacity hover:opacity-90">
                Open export
              </button>
            </div>
          </Section>
        </FadeIn>

        <FadeIn delay={0.135}>
          <Section
            title="Retention & audit"
            description="Local cleanup policy and cot's own configuration trail.">
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Database size"
                value={retention ? formatBytes(retention.db_size_bytes) : '—'}
                warn={!!retention && retention.db_size_bytes >= DB_SIZE_NUDGE_BYTES}
              />
              <Stat
                label="Policy"
                value={
                  retention
                    ? retention.policy.enabled
                      ? `${retention.policy.days} days`
                      : 'Paused'
                    : '—'
                }
                accent={!!retention?.policy.enabled}
              />
              <Stat
                label="Dry-run sessions"
                value={(retention?.preview_sessions ?? 0).toLocaleString()}
              />
            </div>

            {retention &&
              !retention.policy.enabled &&
              retention.db_size_bytes >= DB_SIZE_NUDGE_BYTES && (
                <div className="rounded-lg border border-vermilion/40 bg-vermilion/5 p-4">
                  <p className="font-mono text-xs leading-relaxed text-fg/70">
                    Your local database is{' '}
                    <span className="font-bold text-vermilion">
                      {formatBytes(retention.db_size_bytes)}
                    </span>{' '}
                    and retention is paused, so traces accumulate indefinitely. Enable a
                    policy below to prune old sessions and reclaim disk automatically.
                  </p>
                  <button
                    type="button"
                    disabled={retentionBusy}
                    onClick={() => setRetentionEnabled(true)}
                    className="mt-3 border border-vermilion px-4 py-2 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-vermilion transition-colors hover:bg-vermilion hover:text-cream disabled:cursor-not-allowed disabled:opacity-40">
                    Enable {retention.policy.days}-day retention
                  </button>
                </div>
              )}

            <div className="space-y-4 rounded-lg bg-surface p-4 shadow-soft">
              <PreferenceRow
                label="Retention policy"
                hint={retention ? `Cutoff ${formatRelative(retention.cutoff)}` : undefined}>
                <div className="flex gap-1 rounded-md bg-panel p-1">
                  <ToggleChip
                    label="On"
                    active={!!retention?.policy.enabled}
                    disabled={!retention}
                    onClick={() => setRetentionEnabled(true)}
                  />
                  <ToggleChip
                    label="Paused"
                    active={!!retention && !retention.policy.enabled}
                    disabled={!retention}
                    onClick={() => setRetentionEnabled(false)}
                  />
                </div>
              </PreferenceRow>

              <PreferenceRow label="Window">
                <div className="flex flex-wrap gap-1 rounded-md bg-panel p-1">
                  {[7, 30, 90, 180].map((days) => (
                    <ToggleChip
                      key={days}
                      label={`${days}d`}
                      active={retention?.policy.days === days}
                      disabled={!retention}
                      onClick={() => setRetentionDays(days)}
                    />
                  ))}
                </div>
              </PreferenceRow>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!retention || retentionBusy}
                  onClick={() => runRetentionCleanup(true)}
                  className="border border-line/30 px-4 py-2 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-fg transition-colors hover:border-cobalt hover:text-cobalt disabled:cursor-not-allowed disabled:opacity-40">
                  Dry run
                </button>
                <button
                  type="button"
                  disabled={!retention?.policy.enabled || retentionBusy}
                  onClick={() => runRetentionCleanup(false)}
                  className="border border-vermilion px-4 py-2 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-vermilion transition-colors hover:bg-vermilion hover:text-cream disabled:cursor-not-allowed disabled:opacity-40">
                  Clean now
                </button>
              </div>

              {cleanupResult && (
                <p className="font-mono text-xs text-fg/45">
                  {cleanupResult.dry_run ? 'Dry run found' : 'Cleanup removed'}{' '}
                  {(
                    cleanupResult.dry_run
                      ? cleanupResult.eligible_events
                      : cleanupResult.deleted_events
                  ).toLocaleString()}{' '}
                  events across{' '}
                  {(
                    cleanupResult.dry_run
                      ? cleanupResult.eligible_sessions
                      : cleanupResult.deleted_sessions
                  ).toLocaleString()}{' '}
                  sessions.
                  {!cleanupResult.dry_run && cleanupResult.reclaimed_bytes > 0 && (
                    <> Reclaimed {formatBytes(cleanupResult.reclaimed_bytes)}.</>
                  )}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <p className="font-mono text-[0.65rem] uppercase tracking-widest text-fg/40">
                Self-audit
              </p>
              {auditEvents.length === 0 ? (
                <p className="font-mono text-xs text-fg/40">No cot config events recorded yet.</p>
              ) : (
                <ul className="divide-y divide-line/10 rounded-lg bg-surface shadow-soft">
                  {auditEvents.map((event) => (
                    <li key={event.id} className="flex items-center gap-3 px-4 py-3">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          event.status === 'error'
                            ? 'bg-vermilion'
                            : event.status === 'dry_run'
                              ? 'bg-cobalt'
                              : 'bg-olive'
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs font-bold text-fg">
                          {event.action}
                        </p>
                        <p className="font-mono text-[0.62rem] text-fg/45">
                          {event.actor}
                          {event.target ? ` · ${event.target}` : ''} · {formatRelative(event.ts)}
                        </p>
                      </div>
                      <span className="shrink-0 font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/40">
                        {event.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Section>
        </FadeIn>

        <FadeIn delay={0.14}>
          <Section title="About" description="The cot build running on this machine right now.">
            <div className="space-y-4 rounded-lg bg-surface p-4 shadow-soft">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                  <p className="font-mono text-sm font-bold text-fg">cot collector</p>
                  <p className="font-mono text-xs text-fg/45">Self-hosted · your traces stay local</p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">
                    Running version
                  </p>
                  <p
                    className={`mt-0.5 font-mono text-2xl font-bold tabular-nums ${
                      healthError ? 'text-vermilion' : 'text-fg'
                    }`}>
                    {healthError ? 'Offline' : health?.version ? `v${health.version}` : '…'}
                  </p>
                </div>
              </div>
              <VersionStatus
                info={versionInfo}
                checking={versionChecking}
                checkError={versionCheckError}
                onCheck={checkForUpdates}
                disabled={healthError}
              />
            </div>
          </Section>
        </FadeIn>
      </div>

      {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}
    </div>
  );
}

const HOOK_HEALTH_LABELS: Record<HookHealthState, string> = {
  healthy: 'Healthy',
  missing_hooks: 'Missing hooks',
  not_installed: 'Not installed',
  stale: 'Stale',
  no_events: 'No events yet',
};

function needsHookRepair(agent: HookStatusAgent): boolean {
  return agent.health === 'missing_hooks' || agent.health === 'not_installed';
}

function hookTone(health: HookHealthState): { text: string; dot: string } {
  if (health === 'healthy') return { text: 'text-olive', dot: 'bg-olive' };
  if (health === 'missing_hooks' || health === 'not_installed') {
    return { text: 'text-vermilion', dot: 'bg-vermilion' };
  }
  if (health === 'stale') return { text: 'text-cobalt', dot: 'bg-cobalt' };
  return { text: 'text-fg/45', dot: 'bg-fg/30' };
}

function HookHealthRow({
  agent,
  onReconfigure,
}: {
  agent: HookStatusAgent;
  onReconfigure: () => void;
}) {
  const tone = hookTone(agent.health);
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <AgentMark id={agent.source} className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-sm font-bold text-fg">{sourceLabel(agent.source)}</p>
            <span
              className={`inline-flex items-center gap-1.5 font-mono text-[0.55rem] font-bold uppercase tracking-widest ${tone.text}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
              {HOOK_HEALTH_LABELS[agent.health]}
            </span>
          </div>
          <p className="font-mono text-[0.62rem] text-fg/45">
            {agent.installed_hooks.length}/{agent.expected_hooks.length} hooks ·{' '}
            {agent.missing_hooks.length > 0 ? `${agent.missing_hooks.length} missing` : 'complete'} ·{' '}
            last {formatRelative(agent.last_event)}
          </p>
          {agent.config_path && (
            <p className="truncate font-mono text-[0.6rem] text-fg/35" title={agent.config_path}>
              {shortPath(agent.config_path)}
            </p>
          )}
          {agent.latest_backup && (
            <p
              className="truncate font-mono text-[0.6rem] text-fg/35"
              title={agent.latest_backup.backup_path}>
              backup {formatRelative(agent.latest_backup.created_at)} ·{' '}
              {shortPath(agent.latest_backup.backup_path)}
            </p>
          )}
          {agent.missing_labels.length > 0 && (
            <p className="font-mono text-[0.6rem] text-vermilion/80">
              Missing {agent.missing_labels.slice(0, 3).join(', ')}
              {agent.missing_labels.length > 3 ? ` +${agent.missing_labels.length - 3}` : ''}
            </p>
          )}
        </div>
      </div>
      {needsHookRepair(agent) && (
        <button
          type="button"
          onClick={onReconfigure}
          className="self-start border border-vermilion px-3 py-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-vermilion transition-colors hover:bg-vermilion hover:text-cream sm:self-center">
          Reconfigure
        </button>
      )}
    </li>
  );
}

function VersionStatus({
  info,
  checking,
  checkError,
  onCheck,
  disabled = false,
}: {
  info: VersionInfo | null;
  checking: boolean;
  checkError: string | null;
  onCheck: () => void;
  disabled?: boolean;
}) {
  let status: ReactNode = (
    <span className="font-mono text-xs text-fg/40">
      Check whether a newer release is available.
    </span>
  );

  if (checking) {
    status = <span className="font-mono text-xs text-fg/50">Checking for updates…</span>;
  } else if (checkError) {
    status = <span className="font-mono text-xs text-vermilion/80">{checkError}</span>;
  } else if (info?.latest && info.update_available) {
    status = (
      <span className="inline-flex items-center gap-2 font-mono text-xs font-bold text-vermilion">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-vermilion" />
        Update available · v{info.latest}
      </span>
    );
  } else if (info?.latest) {
    status = (
      <span className="inline-flex items-center gap-2 font-mono text-xs text-fg/50">
        <span className="h-1.5 w-1.5 rounded-full bg-olive" />
        Up to date · latest v{info.latest}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/10 pt-3">
      <div className="min-w-0 flex-1">{status}</div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {info?.update_available && info.url && !checking && (
          <a
            href={info.url}
            target="_blank"
            rel="noreferrer"
            className="border border-vermilion px-3 py-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-vermilion transition-colors hover:bg-vermilion hover:text-cream">
            Update instructions
          </a>
        )}
        <button
          type="button"
          onClick={onCheck}
          disabled={disabled || checking}
          className="border border-line/30 px-3 py-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-fg transition-colors hover:border-cobalt hover:text-cobalt disabled:cursor-not-allowed disabled:opacity-40">
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 border-b border-line/10 pb-10 last:border-0">
      <div className="space-y-1">
        <div className="flex items-center gap-2.5">
          {icon}
          <h2 className="font-mono text-[0.7rem] font-bold uppercase tracking-widest text-fg/55">
            {title}
          </h2>
        </div>
        <p className="font-mono text-xs leading-relaxed text-fg/45">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="rounded-lg bg-surface px-4 py-3 shadow-soft">
      <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">{label}</p>
      <p
        className={`mt-1 font-mono text-sm font-bold tabular-nums ${
          warn ? 'text-vermilion' : accent ? 'text-olive' : 'text-fg'
        }`}
        title={hint}>
        {value}
      </p>
    </div>
  );
}

function PreferenceRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-mono text-sm font-bold text-fg">{label}</p>
        {hint && <p className="font-mono text-xs text-fg/45">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function ToggleChip({
  label,
  active,
  onClick,
  disabled = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-3 py-1.5 font-mono text-[0.65rem] font-bold uppercase tracking-widest transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'bg-surface text-fg shadow-soft' : 'text-fg/45 hover:text-fg'
      }`}>
      {label}
    </button>
  );
}

function shortPath(path: string): string {
  const home = path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/root/, '~');
  if (home.length <= 36) return home;
  const parts = home.split('/');
  return `${parts[0]}/…/${parts[parts.length - 1]}`;
}
