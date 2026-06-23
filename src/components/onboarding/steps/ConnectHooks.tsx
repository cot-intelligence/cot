import { useEffect, useRef, useState } from 'react';
import { getAgent, type AgentId } from '../../../lib/agents';
import { getHookStatus, type HookStatusAgent } from '../../../lib/api';
import { AgentMark } from '../../ui/AgentMark';
import { ShellCommand } from '../../ui/ShellCommand';
import { CodeBlock } from '../../ui/CodeBlock';
import { FadeIn } from '../../ui/FadeIn';

interface ConnectHooksProps {
  agents: AgentId[];
  onBack: () => void;
  onContinue: () => void;
  autoSkip?: boolean;
}

type HookState = 'checking' | 'installed' | 'missing';

interface AgentHookInfo {
  id: AgentId;
  state: HookState;
  status: HookStatusAgent | null;
}

const POLL_MS = 2500;

function deriveState(current: HookStatusAgent | null): HookState {
  if (!current || current.health === 'not_installed' || current.health === 'missing_hooks')
    return 'missing';
  return 'installed';
}

const AUTO_ADVANCE_MS = 6000;

export function ConnectHooks({ agents: agentIds, onBack, onContinue, autoSkip }: ConnectHooksProps) {
  const [agentStates, setAgentStates] = useState<AgentHookInfo[]>(() =>
    agentIds.map((id) => ({ id, state: 'checking', status: null })),
  );
  const [expanded, setExpanded] = useState<AgentId | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const skippedRef = useRef(false);

  useEffect(() => {
    let active = true;
    let firstCheck = true;
    const check = async () => {
      try {
        const hooks = await getHookStatus();
        if (!active) return;
        const states = agentIds.map((id) => {
          const found = hooks.agents.find((a) => a.source === id) ?? null;
          return { id, state: deriveState(found), status: found };
        });
        setAgentStates(states);
        if (firstCheck && autoSkip && !skippedRef.current && states.every((s) => s.state === 'installed')) {
          skippedRef.current = true;
          setAdvancing(true);
          return;
        }
        firstCheck = false;
      } catch {
        if (active) {
          setAgentStates(
            agentIds.map((id) => ({ id, state: 'missing', status: null })),
          );
        }
        firstCheck = false;
      }
      if (active) timer = window.setTimeout(check, POLL_MS);
    };
    let timer = window.setTimeout(check, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [agentIds, autoSkip, onContinue]);

  useEffect(() => {
    if (!advancing) return;
    const t = window.setTimeout(onContinue, AUTO_ADVANCE_MS);
    return () => window.clearTimeout(t);
  }, [advancing, onContinue]);

  const allConnected = agentStates.every((a) => a.state === 'installed');
  const connectedCount = agentStates.filter((a) => a.state === 'installed').length;

  const installCmd = getAgent(agentIds[0]).steps.find((s) => s.kind === 'shell')?.command;

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
            <span>←</span>
            Change agents
          </button>
        </div>
        <h1 className="text-4xl font-extrabold uppercase leading-[0.95] tracking-tight text-fg sm:text-5xl">
          {allConnected ? (
            <>
              All{' '}
              <span className="font-serif lowercase italic text-olive">connected</span>
            </>
          ) : (
            <>
              Wire up{' '}
              <span className="font-serif lowercase italic text-vermilion">hooks</span>
            </>
          )}
        </h1>
        <p className="max-w-md font-mono text-xs leading-relaxed text-fg/55">
          {allConnected
            ? 'All your agents are configured and sending events.'
            : 'One command connects your agents to the local collector — the installer wires up the hooks for you.'}
        </p>
      </header>

      {/* Agent pills */}
      <div className="flex flex-wrap gap-2">
        {agentStates.map((info) => {
          const agent = getAgent(info.id);
          const isExpanded = expanded === info.id;
          return (
            <button
              key={info.id}
              type="button"
              onClick={() => setExpanded(isExpanded ? null : info.id)}
              className={`inline-flex items-center gap-2 border px-3 py-1.5 transition-colors ${
                isExpanded
                  ? 'border-fg/40 bg-fg/5'
                  : info.state === 'installed'
                    ? 'border-olive/40 bg-olive/5 hover:border-olive/60'
                    : info.state === 'checking'
                      ? 'border-fg/20 bg-fg/3 hover:border-fg/30'
                      : 'border-vermilion/30 bg-vermilion/5 hover:border-vermilion/50'
              }`}>
              <AgentMark id={info.id} className="h-4 w-4 shrink-0" variant="25d" />
              <span className="font-mono text-[0.65rem] font-bold text-fg">
                {agent.product}
              </span>
              <AgentBadge state={info.state} />
            </button>
          );
        })}
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="border border-fg/15 bg-surface">
          <div className="px-5 py-4 space-y-4">
            <StatusDetail
              info={agentStates.find((a) => a.id === expanded)!}
              product={getAgent(expanded).product}
            />
            <ManualSteps agentId={expanded} status={agentStates.find((a) => a.id === expanded)?.status ?? null} />
          </div>
        </div>
      )}

      {!allConnected && installCmd && (
        <div className="space-y-3">
          <div className="space-y-1">
            <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-vermilion">
              INSTALL
            </span>
            <p className="font-mono text-[0.7rem] leading-relaxed text-fg/50">
              Run this once — it configures hooks for all selected agents.
            </p>
          </div>
          <ShellCommand command={installCmd} />
        </div>
      )}

      <div className="flex items-center justify-between gap-4 border-t border-fg/10 pt-6">
        <span className="font-mono text-[0.65rem] uppercase tracking-widest text-fg/30">
          {advancing
            ? 'All hooks verified'
            : allConnected
              ? 'Setup complete'
              : `${connectedCount}/${agentIds.length} connected · updates live`}
        </span>
        <button
          type="button"
          onClick={onContinue}
          className={`group relative inline-flex items-center gap-3 overflow-hidden px-7 py-3.5 font-mono text-xs font-bold uppercase tracking-widest shadow-brutal ${
            advancing
              ? 'bg-ink text-cream'
              : 'border border-fg bg-fg text-bg transition-opacity hover:opacity-90'
          }`}>
          {advancing && (
            <>
              <span
                className="absolute inset-y-0 left-0 bg-vermilion"
                style={{ animation: `btn-reveal ${AUTO_ADVANCE_MS}ms cubic-bezier(0.4, 0, 0.2, 1) forwards` }}
              />
              <style>{`@keyframes btn-reveal { from { width: 0% } to { width: 100% } }`}</style>
            </>
          )}
          <span className="relative z-10">
            {advancing ? 'Continuing' : 'Continue'}
          </span>
          <span className={`relative z-10 ${advancing ? '' : 'transition-transform group-hover:translate-x-1'}`}>→</span>
        </button>
      </div>
    </FadeIn>
  );
}


function AgentBadge({ state }: { state: HookState }) {
  if (state === 'installed') {
    return (
      <span className="inline-flex items-center gap-1.5 border border-olive/50 px-2 py-0.5 font-mono text-[0.55rem] font-bold uppercase tracking-widest text-olive">
        <span className="h-1.5 w-1.5 rounded-full bg-olive" />
        Connected
      </span>
    );
  }
  if (state === 'checking') {
    return (
      <span className="inline-flex items-center gap-1.5 border border-fg/20 px-2 py-0.5 font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/40">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cobalt" />
        Checking
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 border border-vermilion/40 px-2 py-0.5 font-mono text-[0.55rem] font-bold uppercase tracking-widest text-vermilion">
      <span className="h-1.5 w-1.5 rounded-full bg-vermilion" />
      Not connected
    </span>
  );
}

function StatusDetail({ info, product }: { info: AgentHookInfo; product: string }) {
  if (info.state === 'installed') {
    return (
      <p className="font-mono text-[0.7rem] leading-relaxed text-fg/60">
        <span className="font-bold text-fg">{product}</span> is connected and
        streaming events.
        {info.status?.events ? ` ${info.status.events} events received.` : ''}
      </p>
    );
  }
  if (info.state === 'checking') {
    return (
      <p className="font-mono text-[0.7rem] text-fg/50">
        Checking whether {product} hooks are installed…
      </p>
    );
  }
  return (
    <p className="font-mono text-[0.7rem] leading-relaxed text-fg/60">
      <span className="font-bold text-fg">{product}</span> is not connected.
      {info.status?.missing_labels?.length
        ? ` Missing ${info.status.missing_labels.slice(0, 3).join(', ')}${info.status.missing_labels.length > 3 ? ` +${info.status.missing_labels.length - 3}` : ''}.`
        : ' Run the installer to set up hooks.'}
    </p>
  );
}

function ManualSteps({
  agentId,
  status,
}: {
  agentId: AgentId;
  status: HookStatusAgent | null;
}) {
  const agent = getAgent(agentId);
  const shellStep = agent.steps.find((s) => s.kind === 'shell');
  const fileSteps = agent.steps.filter((s) => s.kind === 'file');

  return (
    <div className="space-y-4">
      {status && (status.health === 'missing_hooks' || status.health === 'not_installed') && (
        <div className="space-y-1">
          <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-vermilion">
            REPAIR
          </span>
          <a
            href={status.repair_url}
            download={`cot-repair-${agentId}.sh`}
            className="inline-flex border border-vermilion px-3 py-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-vermilion transition-colors hover:bg-vermilion hover:text-cream">
            Download repair script
          </a>
        </div>
      )}
      {shellStep?.command && (
        <div className="space-y-1">
          <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/40">
            INSTALL
          </span>
          <ShellCommand command={shellStep.command} />
        </div>
      )}
      {fileSteps.map(
        (step) =>
          step.code &&
          step.filename && (
            <div key={step.title} className="space-y-1">
              <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/40">
                HOOK CONFIG
              </span>
              <CodeBlock filename={step.filename} code={step.code} />
            </div>
          ),
      )}
    </div>
  );
}
