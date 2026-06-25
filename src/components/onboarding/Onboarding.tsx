import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AgentId } from '../../lib/agents';
import { getHookStatus } from '../../lib/api';
import { Stepper, type StepMeta } from './Stepper';
import { ChooseAgent } from './steps/ChooseAgent';
import { ConnectHooks } from './steps/ConnectHooks';
import { Verify } from './steps/Verify';
import { PostInstall } from './steps/PostInstall';
import { ThemeToggle } from '../ui/ThemeToggle';

const STEPS: StepMeta[] = [
  { id: 'select', label: 'Select' },
  { id: 'connect', label: 'Connect' },
  { id: 'summary', label: 'Summary' },
];

const STORAGE_KEY = 'cot.onboarding.agents';

function readSavedAgents(): AgentId[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = window.localStorage.getItem('cot.onboarding.agent');
      if (legacy === 'claude' || legacy === 'cursor' || legacy === 'codex') return [legacy];
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (x): x is AgentId => x === 'claude' || x === 'cursor' || x === 'codex',
      );
    }
  } catch {
    /* ignore */
  }
  return [];
}

const AGENT_IDS: AgentId[] = ['claude', 'cursor', 'codex'];

interface OnboardingProps {
  onComplete: (agents: AgentId[], origin: { x: number; y: number }) => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [agents, setAgents] = useState<AgentId[]>(readSavedAgents);
  const [manualConnect, setManualConnect] = useState(false);
  const [scriptInstalled, setScriptInstalled] = useState<AgentId[] | null>(null);
  const [checking, setChecking] = useState(true);

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
          try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(installed));
          } catch { /* ignore */ }
          setScriptInstalled(installed);
        }
        setChecking(false);
      })
      .catch(() => {
        if (active) setChecking(false);
      });
    return () => { active = false; };
  }, []);

  const toggleAgent = (id: AgentId) => {
    setAgents((prev) => {
      const next = prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id];
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  if (checking) return null;

  if (scriptInstalled) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <div className="pointer-events-none absolute inset-0 grid-bg" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[60vh] glow-vermilion" aria-hidden="true" />

        <header className="relative z-10 flex items-center justify-between gap-4 px-6 py-5 sm:px-10">
          <a
            href="/"
            className="font-serif text-2xl font-bold italic tracking-tighter text-fg">
            cot.
          </a>
          <ThemeToggle />
        </header>

        <main className="relative z-10 flex flex-1 items-center justify-center px-6 py-12 sm:px-10">
          <div className="w-full max-w-2xl">
            <PostInstall
              agents={scriptInstalled}
              onFinish={(origin) => onComplete(scriptInstalled, origin)}
            />
          </div>
        </main>

        <footer className="relative z-10 flex items-center justify-between px-6 py-5 font-mono text-[0.6rem] uppercase tracking-widest text-fg/25 sm:px-10">
          <span>SELF-HOSTED</span>
          <span>v1.0</span>
        </footer>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="pointer-events-none absolute inset-0 grid-bg" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[60vh] glow-vermilion" aria-hidden="true" />

      <header className="relative z-10 flex items-center justify-between gap-4 px-6 py-5 sm:px-10">
        <a
          href="/"
          className="font-serif text-2xl font-bold italic tracking-tighter text-fg">
          cot.
        </a>
        <div className="flex items-center gap-4 sm:gap-6">
          <Stepper
            steps={STEPS}
            current={step}
            onJump={(i) => i < step && setStep(i)}
          />
          <ThemeToggle />
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-2xl">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}>
              {step === 0 && (
                <ChooseAgent
                  selected={agents}
                  onToggle={toggleAgent}
                  onContinue={() => agents.length > 0 && setStep(1)}
                />
              )}
              {step === 1 && agents.length > 0 && (
                <ConnectHooks
                  agents={agents}
                  onBack={() => setStep(0)}
                  onContinue={() => setStep(2)}
                  autoSkip={!manualConnect}
                />
              )}
              {step === 2 && agents.length > 0 && (
                <Verify
                  agents={agents}
                  onBack={() => setStep(0)}
                  onSetup={() => { setManualConnect(true); setStep(1); }}
                  onFinish={(origin) => onComplete(agents, origin)}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <footer className="relative z-10 flex items-center justify-between px-6 py-5 font-mono text-[0.6rem] uppercase tracking-widest text-fg/25 sm:px-10">
        <span>SELF-HOSTED</span>
        <span>v1.0</span>
      </footer>
    </div>
  );
}
