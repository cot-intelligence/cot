import { useEffect, useState, type ReactNode } from 'react';
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
import { readSavedAgent } from '../../lib/settings';
import { sourceLabel } from '../../lib/sourceLabels';
import { useTheme } from '../../lib/theme';
import { FadeIn } from '../ui/FadeIn';
import { AgentMark } from '../ui/AgentMark';

interface SettingsViewProps {
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  onRunOnboarding: () => void;
}

export function SettingsView({
  sidebarOpen,
  onSidebarOpenChange,
  onRunOnboarding,
}: SettingsViewProps) {
  const { theme, setTheme } = useTheme();
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [hookStatus, setHookStatus] = useState<HookStatus | null>(null);
  const [hookStatusError, setHookStatusError] = useState(false);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [versionChecking, setVersionChecking] = useState(false);
  const [versionCheckError, setVersionCheckError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [retention, setRetention] = useState<RetentionStatus | null>(null);
  const [cleanupResult, setCleanupResult] = useState<RetentionCleanupResult | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [retentionBusy, setRetentionBusy] = useState(false);
  const savedAgent = readSavedAgent();

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await getHealth();
        if (active) {
          setHealth(data);
          setHealthError(false);
        }
      } catch {
        if (active) {
          setHealth(null);
          setHealthError(true);
        }
      }
    };
    load();
    const t = window.setInterval(load, 10000);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await getHookStatus();
        if (active) {
          setHookStatus(data);
          setHookStatusError(false);
        }
      } catch {
        if (active) {
          setHookStatus(null);
          setHookStatusError(true);
        }
      }
    };
    load();
    const t = window.setInterval(load, 10000);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, []);

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
        if (active) setSettings(data);
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
                  {savedAgent ? 'Reconfigure cot' : 'Configure cot'}
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

        <FadeIn delay={0.135}>
          <Section
            title="Retention & audit"
            description="Local cleanup policy and cot's own configuration trail.">
            <div className="grid gap-3 sm:grid-cols-3">
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
              <Stat
                label="Dry-run events"
                value={(retention?.preview_events ?? 0).toLocaleString()}
              />
            </div>

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
            Release notes
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
