import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AgentId } from '../../lib/agents';
import { useTheme } from '../../lib/theme';
import { Icon } from '../forest/icons';
import { EASE_OUT } from '../forest/motion';
import { Wordmark } from '../forest/ui';
import { ConnectHooks } from './steps/ConnectHooks';
import { Found } from './steps/Found';
import { Import } from './steps/Import';
import { useSetup } from './steps/setup';

/** Step swaps: enter 260ms ease-out from the direction of travel, leave in 110ms so the gap
 *  between steps stays short. Full transform strings keep it on the compositor. Reduced motion
 *  (MotionConfig in index.tsx) drops the movement and keeps the fade. */
const STEP_MOTION = {
  enter: (d: 1 | -1) => ({ opacity: 0, transform: `translateX(${d * 16}px)` }),
  shown: { opacity: 1, transform: 'translateX(0px)', transition: { duration: 0.26, ease: EASE_OUT } },
  leave: (d: 1 | -1) => ({ opacity: 0, transform: `translateX(${d * -8}px)`, transition: { duration: 0.11, ease: EASE_OUT } }),
};

type Phase = 'found' | 'connect' | 'import';

const STORAGE_KEY = 'cot.onboarding.agents';

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

/**
 * Setup in three steps, with no mode to pick first: see what's on this machine
 * (going live for the agents that support hooks, importing the rest), connect
 * the live ones, then import history. Hooks and import work together; leaving
 * every Live switch off is how someone sets cot up without hooks.
 */
export function Onboarding({ onComplete }: OnboardingProps) {
  const { theme } = useTheme();
  const [phase, setPhaseRaw] = useState<Phase>('found');
  // Which way the flow is moving, so the swap reads as next (from the right) or back (from the left).
  const [dir, setDir] = useState<1 | -1>(1);
  // Lives here, not in a step: steps remount on every transition.
  const setup = useSetup();
  const live = setup.live ?? [];
  const phases: Phase[] = live.length ? ['found', 'connect', 'import'] : ['found', 'import'];
  const LABELS: Record<Phase, string> = { found: 'Agents', connect: 'Connect', import: 'Import' };
  const at = Math.max(0, phases.indexOf(phase));
  const go = (next: Phase) => {
    setDir(phases.indexOf(next) >= at ? 1 : -1);
    setPhaseRaw(next);
    // A step starts at its top, not wherever the last (longer) one was scrolled to.
    window.scrollTo({ top: 0 });
  };
  const finish = (origin: { x: number; y: number }) => {
    saveAgents(live);
    onComplete(live, origin);
  };

  const body =
    phase === 'found' ? (
      <Found setup={setup} onContinue={(l) => go(l.length ? 'connect' : 'import')} />
    ) : phase === 'connect' && live.length ? (
      <ConnectHooks agents={live} onBack={() => go('found')} onContinue={() => go('import')} autoSkip />
    ) : (
      <Import setup={setup} live={live} step={phases.length} onBack={() => go(live.length ? 'connect' : 'found')} onFinish={finish} />
    );

  return (
    <div className="vf onb" data-theme={theme}>
      <header className="onb-h">
        <span aria-label="cot"><Wordmark size={24} /></span>
        <ol className="onb-steps" aria-label="Setup progress">
          {phases.map((ph, i) => (
            <li key={ph} data-state={i < at ? 'done' : i === at ? 'now' : 'todo'} aria-current={i === at ? 'step' : undefined}>
              <button type="button" disabled={i >= at || setup.started} onClick={() => go(ph)}>
                <span className="onb-n">{i < at ? <Icon name="check" size={12} /> : i + 1}</span>
                <span className="onb-l">{LABELS[ph]}</span>
              </button>
            </li>
          ))}
        </ol>
      </header>
      <main className="onb-m">
        <div className="onb-c">
          <AnimatePresence mode="wait" custom={dir}>
            <motion.div key={phase} custom={dir} variants={STEP_MOTION} initial="enter" animate="shown" exit="leave">
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
