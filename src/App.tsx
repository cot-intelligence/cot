import { useEffect, useState } from 'react';
import { animate, motion, useMotionTemplate, useMotionValue } from 'framer-motion';
import { Dashboard } from './components/dashboard/Dashboard';
import { Onboarding } from './components/onboarding/Onboarding';
import { UpdateBanner } from './components/ui/UpdateBanner';
import { setDocumentTitle } from './lib/documentTitle';
import { identifyInstall } from './lib/analytics';
import type { AgentId } from './lib/agents';

type Origin = { x: number; y: number };

const ONBOARDED_KEY = 'cot.onboarded';

function readOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

function markOnboarded(agents: AgentId[]) {
  try {
    localStorage.setItem(ONBOARDED_KEY, '1');
    localStorage.setItem('cot.onboarding.agents', JSON.stringify(agents));
  } catch {
    /* ignore */
  }
}

export function App() {
  const [view, setView] = useState<'onboarding' | 'dashboard'>(
    readOnboarded() ? 'dashboard' : 'onboarding',
  );
  const [transition, setTransition] = useState<Origin | null>(null);

  useEffect(() => {
    if (!window.location.hash) {
      window.location.hash = '#/sessions';
    }
  }, []);

  useEffect(() => {
    void identifyInstall();
  }, []);

  useEffect(() => {
    if (view === 'onboarding') setDocumentTitle('Setup');
  }, [view]);

  const handleComplete = (agents: AgentId[], origin: Origin) => {
    markOnboarded(agents);
    setTransition(origin);
  };

  const openSetup = () => {
    setView('onboarding');
    window.location.hash = '';
  };

  return (
    <>
      {view === 'onboarding' ? (
        <Onboarding onComplete={handleComplete} />
      ) : (
        <>
          <Dashboard onSetup={openSetup} />
          <UpdateBanner />
        </>
      )}

      {transition && (
        <FluidReveal
          origin={transition}
          onCovered={() => setView('dashboard')}
          onDone={() => {
            setTransition(null);
            window.location.hash = '#/sessions';
          }}
        />
      )}
    </>
  );
}

function FluidReveal({
  origin,
  onCovered,
  onDone,
}: {
  origin: Origin;
  onCovered: () => void;
  onDone: () => void;
}) {
  const radius = useMotionValue(0);
  const clip = useMotionTemplate`circle(${radius}px at ${origin.x}px ${origin.y}px)`;

  useEffect(() => {
    let cancelled = false;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const maxDist =
      Math.hypot(Math.max(origin.x, w - origin.x), Math.max(origin.y, h - origin.y)) * 1.08;
    const ease = [0.65, 0, 0.35, 1] as const;

    const play = (to: number, duration: number, delay = 0) =>
      new Promise<void>((resolve) => {
        animate(radius, to, { duration, ease, delay, onComplete: () => resolve() });
      });

    (async () => {
      await play(maxDist, 0.5);
      if (cancelled) return;
      onCovered();
      await play(0, 0.6, 0.08);
      if (cancelled) return;
      onDone();
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[100] bg-vermilion"
      style={{ clipPath: clip }}
    />
  );
}
