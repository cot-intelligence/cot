import { useEffect, useState } from 'react';
import type { AgentId } from '../../../lib/agents';
import { getPassive, PassiveUnsupportedError, previewSchedule, runPassiveNow, updatePassive, type PassiveStatus } from '../../../lib/api';
import { agentLabel } from '../../forest/AgentMark';
import { fmt } from '../../forest/format';
import { Icon } from '../../forest/icons';
import { AgentSources, HooksGap, RunStatus, SchedulePicker } from '../../passive/PassiveParts';

/**
 * Transcripts-only setup: what's on disk per agent (a scan, nothing imported
 * yet), how often to import, then start. The first import and its analysis run
 * in the background, so the dashboard opens straight away.
 */
export type PassiveDraft = ReturnType<typeof usePassiveDraft>;

/**
 * The choices made across the passive steps. Held by the onboarding shell,
 * which stays mounted, because each step remounts for its page transition.
 */
export function usePassiveDraft() {
  const [p, setP] = useState<PassiveStatus | null>(null);
  const [failed, setFailed] = useState<'unsupported' | 'offline' | false>(false);
  const [agents, setAgents] = useState<AgentId[] | null>(null);
  const [cron, setCron] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      getPassive()
        .then((x) => {
          if (!live) return;
          setP(x);
          // First look: switch on every agent that has transcripts to read.
          setAgents((a) => a ?? x.agents_detail.filter((d) => d.readable && d.transcripts > 0).map((d) => d.agent));
          setCron((c) => c ?? x.cron);
        })
        .catch((e) => live && setFailed(e instanceof PassiveUnsupportedError ? 'unsupported' : 'offline'));
    load();
    const t = started ? window.setInterval(load, 2000) : 0;
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [started]);

  return { p, failed, agents, setAgents, cron, setCron, started, setStarted, err, setErr };
}

export function PassiveSetup({
  step,
  onStep,
  onFinish,
  draft,
}: {
  step: number;
  onStep: (s: number) => void;
  onFinish: (agents: AgentId[], origin: { x: number; y: number }) => void;
  draft: PassiveDraft;
}) {
  const { p, failed, agents, setAgents, cron, setCron, started, setStarted, err, setErr } = draft;
  // Plain English for the chosen schedule, custom crons included.
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!cron) return;
    let live = true;
    previewSchedule(cron).then((r) => live && setLabel(r.valid ? r.description : null)).catch(() => {});
    return () => {
      live = false;
    };
  }, [cron]);

  if (failed) {
    return (
      <Shell
        eyebrow="Transcripts only"
        title={failed === 'unsupported' ? 'This collector needs an update' : "Couldn't reach the collector"}
        lead={
          failed === 'unsupported'
            ? "The cot collector running here predates passive import. Update the cot app, or choose Live hooks for now."
            : 'Passive mode needs the cot collector running on this machine.'
        }>
        <Actions onBack={() => onStep(0)} />
      </Shell>
    );
  }
  if (!p || !agents || !cron) {
    return (
      <Shell eyebrow="Transcripts only" title="Looking for transcripts…" lead="Checking the folders your agents save sessions to.">
        <div className="onb-skel" aria-hidden="true"><span /><span /><span /></div>
      </Shell>
    );
  }

  const readable = p.agents_detail.filter((d) => d.readable);
  const chosen = p.agents_detail.filter((d) => agents.includes(d.agent));
  const total = chosen.reduce((n, d) => n + d.transcripts, 0);
  const running = chosen.reduce((n, d) => n + d.active, 0);
  const toggle = (a: AgentId, on: boolean) => setAgents((prev) => (on ? [...(prev ?? []), a] : (prev ?? []).filter((x) => x !== a)));

  if (step === 1) {
    return (
      <Shell
        eyebrow="Transcripts only · step 1"
        title="Choose agents to import"
        lead={
          readable.length === 0
            ? "The collector can't read any agent's transcripts folder from here."
            : `Found ${fmt.n(p.agents_detail.reduce((n, d) => n + d.transcripts, 0))} transcripts on this machine. Nothing has been imported yet.`
        }>
        <AgentSources detail={p.agents_detail} enabled={agents} onToggle={toggle} />
        {readable.length === 0 && (
          <p className="onb-note">
            <Icon name="eye" size={14} /> A collector running in Docker only sees <span className="mono">~/.cot</span>. Use the desktop app, or Live hooks, to collect from this machine.
          </p>
        )}
        {running > 0 && (
          <p className="onb-note">
            <Icon name="clock" size={14} /> {running} session{running === 1 ? ' is' : 's are'} still running. They'll be imported once they've been quiet for 10 minutes.
          </p>
        )}
        <Actions onBack={() => onStep(0)} next={{ label: 'Continue', disabled: agents.length === 0, onClick: () => onStep(2) }} />
      </Shell>
    );
  }

  if (step === 2) {
    return (
      <Shell eyebrow="Transcripts only · step 2" title="How often should cot import?" lead="Each run reads only what's new since the last one.">
        <SchedulePicker value={cron} presets={p.presets} onChange={setCron} autoApply />
        <div className="card onb-gap">
          <div className="card-h"><span className="card-t">What you don't get without hooks</span></div>
          <div className="card-b"><HooksGap /></div>
        </div>
        <Actions onBack={() => onStep(1)} next={{ label: 'Continue', onClick: () => onStep(3) }} />
      </Shell>
    );
  }

  const start = async () => {
    setErr(null);
    try {
      await updatePassive({ enabled: true, agents, cron });
      await runPassiveNow();
      setStarted(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start the import');
    }
  };

  return (
    <Shell
      eyebrow="Transcripts only · step 3"
      title={started ? 'Importing in the background' : 'Ready to import'}
      lead={
        started
          ? 'Large histories can take a few minutes. Sessions appear as their metadata is imported, and findings follow once analysis finishes. You can start using cot now.'
          : 'cot imports session metadata first, then runs analysis in the background. You can use the dashboard while it works.'
      }>
      <dl className="onb-sum">
        <div><dt>Agents</dt><dd>{chosen.map((d) => agentLabel(d.agent)).join(', ')}</dd></div>
        <div><dt>Transcripts</dt><dd>{fmt.n(total)}</dd></div>
        <div><dt>Schedule</dt><dd>{label ?? <span className="mono">{cron}</span>}</dd></div>
      </dl>
      {started && (
        <div className="card onb-gap"><div className="card-b"><RunStatus status={p} /></div></div>
      )}
      {err && <p role="alert" className="mono" style={{ fontSize: 12, color: 'var(--v-alert)' }}>{err}</p>}
      <Actions
        onBack={started ? undefined : () => onStep(2)}
        next={
          started
            ? { label: 'Open dashboard', onClick: (o) => onFinish(agents, o) }
            : { label: 'Start import', icon: 'bolt', onClick: () => void start() }
        }
      />
    </Shell>
  );
}

function Shell({ eyebrow, title, lead, children }: { eyebrow: string; title: string; lead: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="label">{eyebrow}</span>
      <h1 className="onb-t">{title}</h1>
      <p className="onb-lead dim">{lead}</p>
      <div className="onb-body">{children}</div>
    </div>
  );
}

function Actions({
  onBack,
  next,
}: {
  onBack?: () => void;
  next?: { label: string; icon?: string; disabled?: boolean; onClick: (origin: { x: number; y: number }) => void };
}) {
  return (
    <div className="onb-actions">
      {onBack ? (
        <button type="button" className="vbtn vbtn-ghost" onClick={onBack}><Icon name="back" size={15} />Back</button>
      ) : (
        <span />
      )}
      {next && (
        <button
          type="button"
          className="vbtn vbtn-primary"
          disabled={next.disabled}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            next.onClick({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }}>
          {next.icon && <Icon name={next.icon} size={15} />}
          {next.label}
          {!next.icon && <Icon name="arrow" size={15} />}
        </button>
      )}
    </div>
  );
}
