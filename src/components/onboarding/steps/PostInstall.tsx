import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { AgentId } from '../../../lib/agents';
import { getAgent } from '../../../lib/agents';
import { getImportSummary, type ImportSummary } from '../../../lib/api';
import { AgentMark } from '../../ui/AgentMark';
import { FadeIn } from '../../ui/FadeIn';
import { sourceLabel } from '../../../lib/sourceLabels';

interface PostInstallProps {
  agents: AgentId[];
  onFinish: (origin: { x: number; y: number }) => void;
}

const POLL_MS = 2000;
const TIMEOUT_MS = 15000;

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function PostInstall({ agents, onFinish }: PostInstallProps) {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const data = await getImportSummary();
        if (!active) return;
        setSummary(data);
        if (data.sessions > 0) {
          setLoading(false);
          return;
        }
      } catch {
        /* collector may still be starting */
      }
      if (active) timer = window.setTimeout(poll, POLL_MS);
    };
    poll();

    const timeout = window.setTimeout(() => {
      if (active) setLoading(false);
    }, TIMEOUT_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearTimeout(timeout);
    };
  }, []);

  const sessionCount = summary?.sessions ?? 0;
  const hasSessions = sessionCount > 0;

  return (
    <FadeIn className="space-y-10">
      <header className="space-y-3">
        <span className="inline-block border border-fg bg-fg px-3 py-1 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-bg">
          INSTALLED
        </span>
        <h1 className="text-4xl font-extrabold uppercase leading-[0.95] tracking-tight text-fg sm:text-5xl">
          You&apos;re{' '}
          <span className="font-serif lowercase italic text-olive">all set</span>
        </h1>
        <p className="max-w-md font-mono text-xs leading-relaxed text-fg/55">
          cot is installed and your hooks are connected. Sessions from your agents
          will appear in the dashboard automatically.
        </p>
      </header>

      {/* Connected agents */}
      <div className="flex flex-wrap gap-2">
        {agents.map((id) => {
          const agent = getAgent(id);
          return (
            <span
              key={id}
              className="inline-flex items-center gap-2 border border-olive/40 bg-olive/5 px-3 py-1.5">
              <AgentMark id={id} className="h-4 w-4 shrink-0" variant="25d" />
              <span className="font-mono text-[0.65rem] font-bold text-fg">
                {agent.product}
              </span>
              <span className="inline-flex items-center gap-1 font-mono text-[0.5rem] font-bold uppercase tracking-widest text-olive">
                <span className="h-1.5 w-1.5 rounded-full bg-olive" />
                Connected
              </span>
            </span>
          );
        })}
      </div>

      {/* Import status */}
      <div className="relative overflow-hidden border border-fg/20 bg-surface">
        <div className="flex items-center justify-between border-b border-fg/15 px-5 py-3">
          <span className="font-mono text-[0.6rem] font-bold uppercase tracking-widest text-fg/45">
            IMPORT
          </span>
          <span
            className={`inline-flex items-center gap-2 border px-2 py-1 font-mono text-[0.55rem] font-bold uppercase tracking-widest ${
              hasSessions
                ? 'border-olive bg-olive text-cream'
                : loading
                  ? 'border-cobalt bg-cobalt text-cream'
                  : 'border-fg/30 bg-fg/10 text-fg/50'
            }`}>
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                hasSessions ? 'bg-cream' : loading ? 'bg-cream animate-pulse' : 'bg-fg/30'
              }`}
            />
            {hasSessions ? 'IMPORTED' : loading ? 'PROCESSING' : 'READY'}
          </span>
        </div>

        <div className="px-5 py-6">
          <AnimatePresence mode="wait">
            {loading && !hasSessions ? (
              <motion.div
                key="loading"
                exit={{ opacity: 0 }}
                className="flex items-center gap-4">
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
                  Importing existing sessions…
                </span>
              </motion.div>
            ) : hasSessions ? (
              <motion.div
                key="summary"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="space-y-4">
                <p className="font-mono text-sm text-fg">
                  <span className="font-bold text-vermilion">{formatNumber(sessionCount)}</span>
                  {' '}session{sessionCount !== 1 ? 's' : ''} imported and processing
                  {summary!.by_source.length > 0 && (
                    <span className="text-fg/50">
                      {' — '}
                      {summary!.by_source
                        .map((s) => `${s.sessions} from ${sourceLabel(s.source)}`)
                        .join(', ')}
                    </span>
                  )}
                </p>
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="font-mono text-xs text-fg/40">
                No existing sessions found — your dashboard will populate as you use your agents.
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex items-center justify-end border-t border-fg/10 pt-6">
        <button
          type="button"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onFinish({
              x: e.clientX || rect.left + rect.width / 2,
              y: e.clientY || rect.top + rect.height / 2,
            });
          }}
          className="group inline-flex items-center gap-3 border border-vermilion bg-vermilion px-7 py-3.5 font-mono text-xs font-bold uppercase tracking-widest text-cream shadow-brutal transition-opacity hover:opacity-90">
          Continue to dashboard
          <span className="transition-transform group-hover:translate-x-1">→</span>
        </button>
      </div>
    </FadeIn>
  );
}
