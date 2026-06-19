import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AgentId } from '../../lib/agents';
import { Stepper, type StepMeta } from './Stepper';
import { ChooseAgent } from './steps/ChooseAgent';
import { ConnectHooks } from './steps/ConnectHooks';
import { Verify } from './steps/Verify';
import { ThemeToggle } from '../ui/ThemeToggle';

const STEPS: StepMeta[] = [
  { id: 'select', label: 'Select' },
  { id: 'connect', label: 'Connect' },
  { id: 'verify', label: 'Verify' },
];

const STORAGE_KEY = 'cot.onboarding.agent';

interface OnboardingProps {
  onComplete: (agent: AgentId, origin: { x: number; y: number }) => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [agent, setAgent] = useState<AgentId | null>(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === 'claude' || saved === 'cursor' || saved === 'codex' ? saved : null;
  });

  const selectAgent = (id: AgentId) => {
    setAgent(id);
    window.localStorage.setItem(STORAGE_KEY, id);
  };

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
                  selected={agent}
                  onSelect={selectAgent}
                  onContinue={() => agent && setStep(1)}
                />
              )}
              {step === 1 && agent && (
                <ConnectHooks
                  agentId={agent}
                  onBack={() => setStep(0)}
                  onContinue={() => setStep(2)}
                />
              )}
              {step === 2 && agent && (
                <Verify
                  agentId={agent}
                  onBack={() => setStep(1)}
                  onFinish={(origin) => onComplete(agent, origin)}
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
