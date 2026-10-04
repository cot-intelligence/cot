import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getAgent, type AgentId } from '../../../lib/agents';
import { getHookStatus, getImportSummary, type ImportSummary } from '../../../lib/api';
import { AgentMark } from '../../ui/AgentMark';
import { sourceLabel } from '../../../lib/sourceLabels';
import { FadeIn } from '../../ui/FadeIn';

interface VerifyProps {
  agents: AgentId[];
  onBack: () => void;
  onSetup: () => void;
  onFinish: (origin: { x: number; y: number }) => void;
}

const POLL_MS = 2000;
const TIMEOUT_MS = 15000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

interface AgentConnection {
  id: AgentId;
  connected: boolean;
  events: number;
}

export function Verify({ agents: agentIds, onBack, onSetup, onFinish }: VerifyProps) {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [timedOut, setTimedOut] = useState(false);
  const [connections, setConnections] = useState<AgentConnection[]>(() =>
    agentIds.map((id) => ({ id, connected: false, events: 0 })),
  );

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const [data, hooks] = await Promise.all([getImportSummary(), getHookStatus()]);
        if (!active) return;
        setSummary(data);
        setConnections(
          agentIds.map((id) => {
            const agent = hooks.agents.find((a) => a.source === id);
            const installed = !!agent && agent.health !== 'not_installed' && agent.health !== 'missing_hooks';
            return { id, connected: installed, events: agent?.events ?? 0 };
          }),
        );
        if (data.sessions > 0) {
          setLoading(false);
          return;
        }
      } catch {
        /* collector may not be up yet */
      }
      if (active) timer = window.setTimeout(poll, POLL_MS);
    };
    poll();

    const timeout = window.setTimeout(() => {
      if (active) {
        setLoading(false);
        setTimedOut(true);
      }
    }, TIMEOUT_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearTimeout(timeout);
    };
  }, [agentIds]);

  const hasSessions = summary && summary.sessions > 0;

  return (
    <FadeIn className="space-y-10">
      <header className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <span className="inline-block border rounded-control border-line/[0.16] bg-fg px-3 py-1 font-mono text-label font-semibold uppercase tracking-label text-bg">
            {hasSessions ? 'SUMMARY' : 'READY'}
          </span>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 font-mono text-data font-semibold uppercase tracking-label text-fg/60 transition-colors hover:text-cobalt">
            <span>←</span>
            Change agents
          </button>
        </div>
        <h1 className="text-[2.25rem] font-semibold leading-[1.05] tracking-display text-fg sm:text-[2.75rem]">
          {hasSessions ? (
            <>
              Your{' '}
              <span className="text-hot">history</span>
            </>
          ) : loading ? (
            <>
              Loading{' '}
              <span className="text-hot">history</span>
            </>
          ) : (
            <>
              You&apos;re{' '}
              <span className="text-olive">ready</span>
            </>
          )}
        </h1>
        <p className="max-w-md text-lead text-fg/60">
          {hasSessions
            ? 'cot found your existing agent sessions and imported them into the local database.'
            : loading
              ? 'Scanning for existing agent sessions…'
              : 'No historical sessions found — new sessions will appear as you use your agents.'}
        </p>
      </header>

      {/* Connection status pills */}
      <div className="flex flex-wrap gap-2">
        {connections.map((c) => {
          const agent = getAgent(c.id);
          return (
            <span
              key={c.id}
              className={`inline-flex items-center gap-2 border px-3 py-1.5 ${
                c.connected ? 'border-olive/40 bg-olive/5' : 'border-hot/30 bg-hot/5'
              }`}>
              <AgentMark id={c.id} className="h-4 w-4 shrink-0" variant="25d" />
              <span className="font-mono text-data font-semibold text-fg">
                {agent.product}
              </span>
              <span
                className={`inline-flex items-center gap-1 font-mono text-label font-semibold uppercase tracking-label ${
                  c.connected ? 'text-olive' : 'text-hot'
                }`}>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${c.connected ? 'bg-olive' : 'bg-hot'}`}
                />
                {c.connected ? 'Connected' : 'Not connected'}
              </span>
            </span>
          );
        })}
      </div>

      {/* Import summary card */}
      <div className="relative overflow-hidden rounded-card border border-line/10 bg-surface">
        <div className="flex items-center justify-between border-b border-line/10 px-5 py-3">
          <span className="font-mono text-label font-semibold uppercase tracking-label text-fg/60">
            SESSION HISTORY
          </span>
          <span
            className={`inline-flex items-center gap-2 border px-2 py-1 font-mono text-label font-semibold uppercase tracking-label ${
              hasSessions
                ? 'border-olive bg-olive text-bg'
                : loading
                  ? 'border-cobalt bg-cobalt text-bg'
                  : 'border-line/30 bg-fg/10 text-fg/60'
            }`}>
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                hasSessions ? 'bg-bg' : loading ? 'bg-bg animate-pulse' : 'bg-fg/30'
              }`}
            />
            {hasSessions ? 'IMPORTED' : loading ? 'SCANNING' : 'EMPTY'}
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
                      className="h-2 w-2 rounded-full bg-hot"
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
                <span className="font-mono text-xs text-fg/60">
                  Scanning agent transcripts…
                </span>
              </motion.div>
            ) : hasSessions ? (
              <motion.div
                key="summary"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
                className="space-y-5">
                <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-cell border border-line/10 bg-line/10 sm:grid-cols-4">
                  <Cell label="SESSIONS" value={String(summary!.sessions)} />
                  <Cell label="TOKENS" value={formatTokens(summary!.tokens.total)} accent />
                  <Cell
                    label="FROM"
                    value={summary!.earliest ? formatDate(summary!.earliest) : '—'}
                  />
                  <Cell
                    label="TO"
                    value={summary!.latest ? formatDate(summary!.latest) : '—'}
                  />
                </dl>

                {summary!.by_source.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {summary!.by_source.map((s) => (
                      <span
                        key={s.source}
                        className="inline-flex items-center gap-1.5 border rounded-control border-line/10 px-2.5 py-1 font-mono text-label text-fg/60">
                        <span className="font-semibold text-fg">{sourceLabel(s.source)}</span>
                        {s.sessions} sessions · {s.events} events
                      </span>
                    ))}
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="font-mono text-xs text-fg/40">
                {timedOut
                  ? 'No existing sessions were found. Your dashboard will populate as you use your agents.'
                  : 'Ready to go.'}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line/10 pt-6">
        <button
          type="button"
          onClick={onSetup}
          className="font-mono text-data font-semibold uppercase tracking-label text-fg/40 transition-colors hover:text-cobalt">
          Manual setup &amp; testing →
        </button>
        <button
          type="button"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onFinish({
              x: e.clientX || rect.left + rect.width / 2,
              y: e.clientY || rect.top + rect.height / 2,
            });
          }}
          className="group btn-primary px-5 py-2.5 text-body">
          Open dashboard
          <span className="transition-transform group-hover:translate-x-1">→</span>
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
      <dt className="font-mono text-label uppercase tracking-label text-fg/40">
        {label}
      </dt>
      <dd
        className={`mt-1 truncate font-mono text-sm font-semibold ${accent ? 'text-hot' : 'text-fg'}`}>
        {value}
      </dd>
    </div>
  );
}
