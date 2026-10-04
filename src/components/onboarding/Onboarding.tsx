import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AgentId } from '../../lib/agents';
import { getHookStatus } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { Icon } from '../forest/icons';
import { EASE_OUT } from '../forest/motion';
import { Wordmark } from '../forest/ui';
import { ChooseAgent } from './steps/ChooseAgent';
import { ConnectHooks } from './steps/ConnectHooks';
import { PassiveSetup, usePassiveDraft } from './steps/PassiveSetup';
import { PostInstall } from './steps/PostInstall';
import { Verify } from './steps/Verify';

type Mode = 'hooks' | 'passive';

/** Step swaps: enter 260ms ease-out from the direction of travel, leave in 110ms so the gap
 *  between steps stays short. Full transform strings keep it on the compositor. Reduced motion
 *  (MotionConfig in index.tsx) drops the movement and keeps the fade. */
const STEP_MOTION = {
  enter: (d: 1 | -1) => ({ opacity: 0, transform: `translateX(${d * 16}px)` }),
  shown: { opacity: 1, transform: 'translateX(0px)', transition: { duration: 0.26, ease: EASE_OUT } },
  leave: (d: 1 | -1) => ({ opacity: 0, transform: `translateX(${d * -8}px)`, transition: { duration: 0.11, ease: EASE_OUT } }),
};

const STEPS: Record<Mode, string[]> = {
  hooks: ['Mode', 'Agents', 'Connect', 'Summary'],
  passive: ['Mode', 'Agents', 'Schedule', 'Start'],
};

const STORAGE_KEY = 'cot.onboarding.agents';
const AGENT_IDS: AgentId[] = ['claude', 'cursor', 'codex', 'opencode'];

function readSavedAgents(): AgentId[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = window.localStorage.getItem('cot.onboarding.agent');
      if (legacy === 'claude' || legacy === 'cursor' || legacy === 'codex' || legacy === 'opencode') return [legacy];
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is AgentId => AGENT_IDS.includes(x as AgentId));
  } catch {
    /* ignore */
  }
  return [];
}

function saveAgents(agents: AgentId[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(agents));
  } catch {
    /* ignore */
  }
}

interface OnboardingProps {
  onComplete: (agents: AgentId[], origin: { x: number; y: number }) => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const { theme } = useTheme();
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStepRaw] = useState(0);
  // Which way the flow is moving, so the swap reads as next (from the right) or back (from the left).
  const [dir, setDir] = useState<1 | -1>(1);
  const setStep = (next: number) => {
    setDir(next >= step ? 1 : -1);
    setStepRaw(next);
  };
  const [agents, setAgents] = useState<AgentId[]>(readSavedAgents);
  const [manualConnect, setManualConnect] = useState(false);
  const [scriptInstalled, setScriptInstalled] = useState<AgentId[] | null>(null);
  const [checking, setChecking] = useState(true);
  // Lives here, not in the step: steps remount on every transition.
  const passiveDraft = usePassiveDraft();

  useEffect(() => {
    let active = true;
    getHookStatus()
      .then((hooks) => {
        if (!active) return;
        const installed = AGENT_IDS.filter((id) => {
          const agent = hooks.agents.find((a) => a.source === id);
          return agent && agent.health !== 'not_installed' && agent.health !== 'missing_hooks';
        });
        if (installed.length > 0) {
          saveAgents(installed);
          setScriptInstalled(installed);
        }
        setChecking(false);
      })
      .catch(() => active && setChecking(false));
    return () => {
      active = false;
    };
  }, []);

  const toggleAgent = (id: AgentId) =>
    setAgents((prev) => {
      const next = prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id];
      saveAgents(next);
      return next;
    });

  if (checking) return null;

  const steps = STEPS[mode ?? 'hooks'];
  const body = scriptInstalled ? (
    <PostInstall agents={scriptInstalled} onFinish={(origin) => onComplete(scriptInstalled, origin)} />
  ) : step === 0 || !mode ? (
    <ChooseMode
      mode={mode}
      onPick={setMode}
      onContinue={() => mode && setStep(1)}
    />
  ) : mode === 'passive' ? (
    <PassiveSetup
      draft={passiveDraft}
      step={step}
      onStep={setStep}
      onFinish={(chosen, origin) => {
        saveAgents(chosen);
        onComplete(chosen, origin);
      }}
    />
  ) : step === 1 ? (
    <ChooseAgent selected={agents} onToggle={toggleAgent} onContinue={() => agents.length > 0 && setStep(2)} />
  ) : step === 2 && agents.length > 0 ? (
    <ConnectHooks agents={agents} onBack={() => setStep(1)} onContinue={() => setStep(3)} autoSkip={!manualConnect} />
  ) : (
    <Verify
      agents={agents}
      onBack={() => setStep(1)}
      onSetup={() => {
        setManualConnect(true);
        setStep(2);
      }}
      onFinish={(origin) => onComplete(agents, origin)}
    />
  );

  return (
    <div className="vf onb" data-theme={theme}>
      <header className="onb-h">
        <span aria-label="cot"><Wordmark size={24} /></span>
        {!scriptInstalled && (
          <ol className="onb-steps" aria-label="Setup progress">
            {steps.map((label, i) => (
              <li key={label} data-state={i < step ? 'done' : i === step ? 'now' : 'todo'} aria-current={i === step ? 'step' : undefined}>
                <button type="button" disabled={i >= step} onClick={() => setStep(i)}>
                  <span className="onb-n">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>
                  <span className="onb-l">{label}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </header>
      <main className="onb-m">
        <div className="onb-c">
          <AnimatePresence mode="wait" custom={dir}>
            <motion.div
              key={scriptInstalled ? 'installed' : step === 0 ? 'mode' : `${mode}-${step}`}
              custom={dir}
              variants={STEP_MOTION}
              initial="enter"
              animate="shown"
              exit="leave">
              {body}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      <footer className="onb-f mono faint">
        <span>Self-hosted · your traces stay on this machine</span>
      </footer>
    </div>
  );
}

const MODES: { id: Mode; title: string; tag?: string; lead: string; points: string[]; icon: string }[] = [
  {
    id: 'hooks',
    title: 'Live hooks',
    tag: 'Recommended',
    icon: 'bolt',
    lead: 'Adds a small hook to each agent so every event reaches cot as it happens.',
    points: ['Live traces and running sessions', 'Permission prompts and exact timings', 'Every finding, as soon as it happens'],
  },
  {
    id: 'passive',
    title: 'Transcripts only',
    tag: 'Passive',
    icon: 'clock',
    lead: 'Nothing is installed in your agents. cot reads the transcripts they already save, on a schedule you set.',
    points: ['No changes to agent config', 'Imports your full history', 'Sessions on a schedule, not live'],
  },
];

function ChooseMode({ mode, onPick, onContinue }: { mode: Mode | null; onPick: (m: Mode) => void; onContinue: () => void }) {
  return (
    <div>
      <span className="label">Get started</span>
      <h1 className="onb-t">How should cot collect your sessions?</h1>
      <p className="onb-lead dim">You can change this later, or use both, in Settings.</p>
      <div className="onb-modes" role="radiogroup" aria-label="Collection mode">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className="onb-mode" onClick={() => onPick(m.id)}>
            <span className="onb-mode-h">
              <span className="onb-mode-ic"><Icon name={m.icon} size={16} /></span>
              <b>{m.title}</b>
              {m.tag && <span className={`vchip ${m.id === 'hooks' ? 'c-ok' : 'c-dim'}`}>{m.tag}</span>}
              <span className="onb-radio" aria-hidden="true" />
            </span>
            <span className="onb-mode-lead">{m.lead}</span>
            <ul>
              {m.points.map((p) => (
                <li key={p}><Icon name="check" size={13} />{p}</li>
              ))}
            </ul>
          </button>
        ))}
      </div>
      <div className="onb-actions">
        <span />
        <button type="button" className="vbtn vbtn-primary" disabled={!mode} onClick={onContinue}>
          Continue <Icon name="arrow" size={15} />
        </button>
      </div>
    </div>
  );
}
