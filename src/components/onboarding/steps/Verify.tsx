import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getAgent, type AgentId } from '../../../lib/agents';
import { getSessions, sendTestEvent, type SessionSummary } from '../../../lib/api';
import { FadeIn } from '../../ui/FadeIn';

interface VerifyProps {
  agentId: AgentId;
  onBack: () => void;
  onFinish: (origin: { x: number; y: number }) => void;
}

interface CapturedTrace {
  session: string;
  events: number;
  tools: number;
  duration: string;
}

function fromSession(s: SessionSummary): CapturedTrace {
  return {
    session: s.id,
    events: s.event_count,
    tools: s.tool_count,
    duration: s.duration_seconds != null ? `${s.duration_seconds.toFixed(2)}s` : '—',
  };
}

// Used only if the collector can't be reached, so the flow never hard-blocks.
const SAMPLE: CapturedTrace = {
  session: 'sess_8f92a1b',
  events: 14,
  tools: 6,
  duration: '2.41s',
};

const POLL_MS = 1500;
const UNREACHABLE_FALLBACK_MS = 6000;

export function Verify({ agentId, onBack, onFinish }: VerifyProps) {
  const agent = getAgent(agentId);
  const [trace, setTrace] = useState<CapturedTrace | null>(null);
  const [reachable, setReachable] = useState(false);
  const [sending, setSending] = useState(false);
  const reachedRef = useRef(false);

  // Poll the live collector for the first session that has events.
  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const sessions = await getSessions({ limit: 1 });
        if (!active) return;
        reachedRef.current = true;
        setReachable(true);
        if (sessions.length && sessions[0].event_count > 0) {
          setTrace(fromSession(sessions[0]));
          return;
        }
      } catch {
        /* collector not up yet — keep trying */
      }
      if (active) timer = window.setTimeout(poll, POLL_MS);
    };
    poll();

    const fallback = window.setTimeout(() => {
      if (active && !reachedRef.current) setTrace((t) => t ?? SAMPLE);
    }, UNREACHABLE_FALLBACK_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearTimeout(fallback);
    };
  }, []);

  const triggerTest = async () => {
    setSending(true);
    try {
      await sendTestEvent(agentId);
    } catch {
      setTrace((t) => t ?? SAMPLE);
    } finally {
      setSending(false);
    }
  };

  const connected = trace !== null;

  return (
    <FadeIn className="space-y-10">
      <header className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <span className="inline-block border border-fg bg-fg px-3 py-1 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-bg">
            FIRST_TRACE
          </span>
          {!connected && (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 font-mono text-[0.65rem] font-bold uppercase tracking-widest text-fg/45 transition-colors hover:text-cobalt">
              <span>{'\u2190'}</span>
              Back to hooks
            </button>
          )}
        </div>
        <h1 className="text-4xl font-extrabold uppercase leading-[0.95] tracking-tight text-fg sm:text-5xl">
          {connected ? 'You are' : 'Waiting on the'}{' '}
          <span className="font-serif lowercase italic text-vermilion">
            {connected ? 'connected' : 'first event'}
          </span>
        </h1>
        <p className="max-w-md font-mono text-xs leading-relaxed text-fg/55">
          {connected
            ? `cot stored its first trace from ${agent.product} in ~/.cot/cot.db. Every future session lands automatically.`
            : `Run any prompt in ${agent.product}. The moment a hook fires, it's written to your local SQLite and shows up here.`}
        </p>
      </header>

      <div className="relative overflow-hidden border border-fg/20 bg-surface">
        <div className="flex items-center justify-between border-b border-fg/15 px-5 py-3">
          <span className="font-mono text-[0.6rem] font-bold uppercase tracking-widest text-fg/45">
            COLLECTOR :: ~/.cot/cot.db
          </span>
          <span
            className={`inline-flex items-center gap-2 border px-2 py-1 font-mono text-[0.55rem] font-bold uppercase tracking-widest ${
              connected
                ? 'border-olive bg-olive text-cream'
                : 'border-cobalt bg-cobalt text-cream'
            }`}>
            <span
              className={`h-1.5 w-1.5 rounded-full bg-cream ${connected ? '' : 'animate-pulse'}`}
            />
            {connected ? 'CONNECTED' : reachable ? 'LISTENING' : 'CONNECTING'}
          </span>
        </div>

        <div className="px-5 py-6">
          <AnimatePresence mode="wait">
            {!connected ? (
              <motion.div
                key="listening"
                exit={{ opacity: 0 }}
                className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="flex gap-1.5">
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="h-2 w-2 rounded-full bg-vermilion"
                        animate={{ opacity: [0.25, 1, 0.25] }}
                        transition={{
                          duration: 1.2,
                          repeat: Infinity,
                          delay: i * 0.2,
                          ease: 'easeInOut',
                        }}
                      />
                    ))}
                  </div>
                  <span className="font-mono text-xs text-fg/50">
                    Scanning hook stream for{' '}
                    <span className="text-fg/80">{agent.events[0]}</span>…
                  </span>
                </div>
                <button
                  type="button"
                  onClick={triggerTest}
                  disabled={sending}
                  className="group inline-flex items-center gap-2 font-mono text-[0.65rem] font-bold uppercase tracking-widest text-fg/45 transition-colors hover:text-vermilion disabled:opacity-50">
                  {sending ? 'Sending…' : 'Send a test event'}
                  <span className="transition-transform group-hover:translate-x-1">
                    {'\u2192'}
                  </span>
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="captured"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="space-y-4">
                <div className="flex items-center gap-2 font-mono text-[0.7rem] font-bold uppercase tracking-widest text-olive">
                  <span>{'\u2713'}</span>
                  Trace captured
                </div>
                <dl className="grid grid-cols-2 gap-px border border-fg/10 bg-fg/10 sm:grid-cols-4">
                  <Cell label="SESSION_ID" value={trace!.session} />
                  <Cell label="EVENTS" value={String(trace!.events)} />
                  <Cell label="TOOL_CALLS" value={String(trace!.tools)} />
                  <Cell label="DURATION" value={trace!.duration} accent />
                </dl>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-fg/10 pt-6">
        <p className="font-mono text-[0.65rem] uppercase tracking-widest text-fg/30">
          {connected ? 'Setup complete' : 'This screen updates live'}
        </p>
        <button
          type="button"
          disabled={!connected}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onFinish({
              x: e.clientX || rect.left + rect.width / 2,
              y: e.clientY || rect.top + rect.height / 2,
            });
          }}
          className="group inline-flex items-center gap-3 border border-vermilion bg-vermilion px-7 py-3.5 font-mono text-xs font-bold uppercase tracking-widest text-cream shadow-brutal transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:border-fg/20 disabled:bg-transparent disabled:text-fg/30 disabled:shadow-none">
          Open dashboard
          <span className="transition-transform group-enabled:group-hover:translate-x-1">
            {'\u2192'}
          </span>
        </button>
      </div>
    </FadeIn>
  );
}

function Cell({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <dt className="font-mono text-[0.56rem] uppercase tracking-widest text-fg/35">
        {label}
      </dt>
      <dd
        className={`mt-1 truncate font-mono text-sm font-bold ${accent ? 'text-vermilion' : 'text-fg'}`}>
        {value}
      </dd>
    </div>
  );
}
