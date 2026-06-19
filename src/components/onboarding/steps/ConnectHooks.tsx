import { useEffect, useState, type ReactNode } from 'react';
import { getAgent, type AgentId } from '../../../lib/agents';
import { getHookStatus, type HookStatusAgent } from '../../../lib/api';
import { AgentMark } from '../../ui/AgentMark';
import { ShellCommand } from '../../ui/ShellCommand';
import { CodeBlock } from '../../ui/CodeBlock';
import { FadeIn } from '../../ui/FadeIn';

interface ConnectHooksProps {
  agentId: AgentId;
  onBack: () => void;
  onContinue: () => void;
}

type HookState = 'checking' | 'installed' | 'missing' | 'stale' | 'no_events';

const POLL_MS = 2500;

export function ConnectHooks({ agentId, onBack, onContinue }: ConnectHooksProps) {
  const agent = getAgent(agentId);
  const [state, setState] = useState<HookState>('checking');
  const [status, setStatus] = useState<HookStatusAgent | null>(null);
  const [showSteps, setShowSteps] = useState(false);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const hooks = await getHookStatus();
        if (!active) return;
        const current = hooks.agents.find((a) => a.source === agentId) ?? null;
        setStatus(current);
        if (!current || current.health === 'not_installed' || current.health === 'missing_hooks') {
          setState('missing');
        } else if (current.health === 'stale') {
          setState('stale');
        } else if (current.health === 'no_events') {
          setState('no_events');
        } else {
          setState('installed');
        }
      } catch {
        if (active) {
          setStatus(null);
          setState('missing');
        }
      }
      if (active) timer = window.setTimeout(check, POLL_MS);
    };
    let timer = window.setTimeout(check, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [agentId]);

  const installStep = agent.steps.find((s) => s.kind === 'shell');
  const manualSteps = agent.steps.filter((s) => s.kind === 'file');
  const installed = state === 'installed';
  const hooksConfigured = installed || state === 'stale' || state === 'no_events';
  const stepsVisible = !hooksConfigured || showSteps;

  return (
    <FadeIn className="space-y-10">
      <header className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <span className="inline-block border border-fg bg-fg px-3 py-1 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-bg">
            HOOK_SETUP
          </span>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 font-mono text-[0.65rem] font-bold uppercase tracking-widest text-fg/45 transition-colors hover:text-cobalt">
            <span className="transition-transform">{'\u2190'}</span>
            Change agent
          </button>
        </div>
        <h1 className="flex items-center gap-3 text-4xl font-extrabold uppercase leading-[0.95] tracking-tight text-fg sm:text-5xl">
          <AgentMark id={agent.id} className="h-8 w-8" variant="25d" />
          {hooksConfigured ? (
            <>
              Hooks are{' '}
              <span className="font-serif lowercase italic text-olive">
                {installed ? 'live' : 'wired'}
              </span>
            </>
          ) : (
            <>
              Wire up{' '}
              <span className="font-serif lowercase italic text-vermilion">hooks</span>
            </>
          )}
        </h1>
        <p className="max-w-md font-mono text-xs leading-relaxed text-fg/55">
          {hooksConfigured ? (
            <>
              {agent.product} hooks are configured. Continue to confirm your first trace.
            </>
          ) : (
            <>
              One command connects {agent.product} to your local collector — the
              installer wires up the hooks for you. cot listens for{' '}
              <span className="text-fg/80">{agent.events.length} events</span> and
              stitches them into traces.
            </>
          )}
        </p>
      </header>

      <StatusBanner state={state} product={agent.product} status={status} />

      {stepsVisible && (
        <div className="space-y-7">
          {status && (status.health === 'missing_hooks' || status.health === 'not_installed') && (
            <Step
              index={1}
              tag="REPAIR"
              title="Repair hooks"
              detail="Download a local repair script to refresh cot's hook entries from this setup flow."
              recommended
              last={!installStep?.command && manualSteps.length === 0}>
              <a
                href={status.repair_url}
                download={`cot-repair-${agent.id}.sh`}
                className="inline-flex border border-vermilion px-4 py-2 font-mono text-[0.65rem] font-bold uppercase tracking-widest text-vermilion transition-colors hover:bg-vermilion hover:text-cream">
                Download repair script
              </a>
            </Step>
          )}

          {installStep?.command && (
            <Step
              index={
                status && (status.health === 'missing_hooks' || status.health === 'not_installed')
                  ? 2
                  : 1
              }
              tag={installStep.tag}
              title={installStep.title}
              detail={installStep.detail}
              recommended={!hooksConfigured && !status}
              last={manualSteps.length === 0}>
              <ShellCommand command={installStep.command} />
            </Step>
          )}

          {manualSteps.length > 0 && (
            <Step
              index={
                status && (status.health === 'missing_hooks' || status.health === 'not_installed')
                  ? 3
                  : 2
              }
              tag="MANUAL"
              title="Prefer to wire it up yourself?"
              detail={`Skip the installer and add the hooks to ${manualSteps[0].filename} by hand. The installer does exactly this.`}
              last>
              <div className="space-y-3">
                {manualSteps.map(
                  (step) =>
                    step.code &&
                    step.filename && (
                      <CodeBlock
                        key={step.title}
                        filename={step.filename}
                        code={step.code}
                      />
                    ),
                )}
              </div>
            </Step>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-4 border-t border-fg/10 pt-6">
        {hooksConfigured ? (
          <button
            type="button"
            onClick={() => setShowSteps((v) => !v)}
            className="font-mono text-[0.65rem] font-bold uppercase tracking-widest text-fg/40 transition-colors hover:text-cobalt">
            {showSteps ? 'Hide setup steps' : 'View setup steps'}
          </button>
        ) : (
          <span className="font-mono text-[0.65rem] uppercase tracking-widest text-fg/30">
            This screen detects hooks live
          </span>
        )}
        <button
          type="button"
          onClick={onContinue}
          className="group inline-flex items-center gap-3 border border-fg bg-fg px-7 py-3.5 font-mono text-xs font-bold uppercase tracking-widest text-bg shadow-brutal transition-opacity hover:opacity-90">
          {hooksConfigured ? 'Continue' : "I've added the hooks"}
          <span className="transition-transform group-hover:translate-x-1">
            {'\u2192'}
          </span>
        </button>
      </div>
    </FadeIn>
  );
}

function StatusBanner({
  state,
  product,
  status,
}: {
  state: HookState;
  product: string;
  status: HookStatusAgent | null;
}) {
  if (state === 'installed') {
    return (
      <div className="flex items-center gap-3 border border-olive/40 bg-olive/10 px-4 py-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center border border-olive bg-olive font-mono text-xs font-bold text-cream">
          {'\u2713'}
        </span>
        <p className="font-mono text-[0.7rem] leading-relaxed text-fg/70">
          <span className="font-bold text-fg">Hooks installed.</span> {product} is
          connected and streaming events.
        </p>
      </div>
    );
  }

  if (state === 'stale' || state === 'no_events') {
    return (
      <div className="flex items-center gap-3 border border-cobalt/30 bg-cobalt/5 px-4 py-3">
        <span className="h-2 w-2 shrink-0 rounded-full bg-cobalt" />
        <p className="font-mono text-[0.7rem] leading-relaxed text-fg/65">
          <span className="font-bold text-fg">
            {state === 'stale' ? 'Hooks installed.' : 'Hooks configured.'}
          </span>{' '}
          {state === 'stale'
            ? `${product} has sent events before, but not recently.`
            : `${product} has not sent its first event yet.`}
        </p>
      </div>
    );
  }

  if (state === 'checking') {
    return (
      <div className="flex items-center gap-3 border border-fg/20 bg-panel px-4 py-3">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-cobalt" />
        <p className="font-mono text-[0.7rem] text-fg/55">
          Checking whether hooks are already installed…
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 border border-vermilion/30 bg-vermilion/5 px-4 py-3">
      <span className="h-2 w-2 shrink-0 rounded-full bg-vermilion" />
      <p className="font-mono text-[0.7rem] leading-relaxed text-fg/65">
        <span className="font-bold text-fg">Not connected yet.</span> Run the
        installer below — this updates automatically once {product} sends its
        first event.
        {status?.missing_labels?.length ? (
          <>
            {' '}
            Missing {status.missing_labels.slice(0, 3).join(', ')}
            {status.missing_labels.length > 3 ? ` +${status.missing_labels.length - 3}` : ''}.
          </>
        ) : null}
      </p>
    </div>
  );
}

function Step({
  index,
  tag,
  title,
  detail,
  children,
  recommended = false,
  last = false,
}: {
  index: number;
  tag: string;
  title: string;
  detail: string;
  children: ReactNode;
  recommended?: boolean;
  last?: boolean;
}) {
  return (
    <div className="relative flex gap-4 sm:gap-5">
      <div className="flex flex-col items-center">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-fg/30 font-mono text-[0.65rem] font-bold tabular-nums text-fg">
          {String(index).padStart(2, '0')}
        </span>
        {!last && <span className="mt-2 w-px flex-1 bg-fg/15" />}
      </div>

      <div className="min-w-0 flex-1 space-y-3 pb-1">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-vermilion">
              {tag}
            </span>
            {recommended && (
              <span className="border border-olive/50 px-1.5 py-0.5 font-mono text-[0.5rem] font-bold uppercase tracking-widest text-olive">
                Recommended
              </span>
            )}
          </div>
          <h2 className="font-serif text-xl font-bold italic text-fg">{title}</h2>
          <p className="font-mono text-[0.7rem] leading-relaxed text-fg/50">
            {detail}
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
