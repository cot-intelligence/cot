import { useEffect, useRef, useState } from 'react';
import { getAgent, type AgentId } from '../../../lib/agents';
import { getHookStatus, type HookStatusAgent } from '../../../lib/api';
import { ShellCommand } from '../../ui/ShellCommand';
import { CodeBlock } from '../../ui/CodeBlock';
import { Icon } from '../../forest/icons';
import { Actions, Shell, StatusRow } from './Shell';

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
    <Shell
      eyebrow="Set up cot · step 2"
      title={allConnected ? 'Hooks connected' : 'Connect your agents'}
      lead={
        allConnected
          ? 'Every agent you picked is wired to the local collector.'
          : 'Run one command and the installer adds the hooks to every agent you picked. This page updates as each one connects.'
      }>
      {!allConnected && installCmd && (
        <div className="onb-cmd">
          <span className="label">Run once in a terminal</span>
          <ShellCommand command={installCmd} />
        </div>
      )}
      <ul className="onb-status" aria-live="polite">
        {agentStates.map((info) => {
          const agent = getAgent(info.id);
          const open = expanded === info.id;
          const missing = info.status?.missing_labels ?? [];
          return (
            <StatusRow
              key={info.id}
              id={info.id}
              name={agent.product}
              tone={info.state === 'installed' ? 'ok' : info.state === 'checking' ? 'wait' : missing.length ? 'warn' : 'off'}
              status={info.state === 'installed' ? 'Connected' : info.state === 'checking' ? 'Checking' : missing.length ? 'Hooks missing' : 'Waiting'}
              detail={
                info.state === 'installed'
                  ? info.status?.events ? `${info.status.events.toLocaleString()} events received` : 'No events yet. Use the agent once to see them.'
                  : missing.length
                    ? `Missing ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}`
                    : undefined
              }
              action={
                info.state !== 'installed' && (
                  <button type="button" className="vbtn vbtn-ghost vbtn-sm" aria-expanded={open} onClick={() => setExpanded(open ? null : info.id)}>
                    Manual setup <Icon name="down" size={14} className="onb-chev" />
                  </button>
                )
              }>
              {open && <ManualSteps agentId={info.id} status={info.status} />}
            </StatusRow>
          );
        })}
      </ul>
      <Actions
        onBack={onBack}
        backLabel="Change agents"
        extra={!advancing && !allConnected && (
          <span className="mono faint onb-count">{connectedCount} of {agentIds.length} connected</span>
        )}
        next={{ label: advancing ? 'Continuing' : 'Continue', autoMs: advancing ? AUTO_ADVANCE_MS : undefined, onClick: onContinue }}
      />
    </Shell>
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
  const fileSteps = agent.steps.filter((s) => s.kind === 'file');

  return (
    <div className="onb-manual">
      {status && (status.health === 'missing_hooks' || status.health === 'not_installed') && (
        <div className="space-y-1">
          <span className="label">Repair</span>
          <a href={status.repair_url} download={`cot-repair-${agentId}.sh`} className="vbtn vbtn-quiet vbtn-sm">
            <Icon name="download" size={14} />Download repair script
          </a>
        </div>
      )}
      {agentId === 'opencode' && (
        <div className="space-y-1">
          <span className="label">Manual plugin</span>
          <p className="onb-note">Save the plugin as ~/.config/opencode/plugins/cot.js, then restart OpenCode.</p>
          <a href="/opencode-plugin.js" download="cot.js" className="vbtn vbtn-quiet vbtn-sm"><Icon name="download" size={14} />cot.js</a>
        </div>
      )}
      {agentId === 'hermes' && (
        <div className="space-y-1">
          <span className="label">Manual plugin</span>
          <p className="onb-note">Save both files to ~/.hermes/plugins/cot/, run hermes plugins enable cot, then restart Hermes.</p>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <a href="/hermes-plugin/plugin.yaml" download="plugin.yaml" className="vbtn vbtn-quiet vbtn-sm"><Icon name="download" size={14} />plugin.yaml</a>
            <a href="/hermes-plugin/__init__.py" download="__init__.py" className="vbtn vbtn-quiet vbtn-sm"><Icon name="download" size={14} />__init__.py</a>
          </span>
        </div>
      )}
      {fileSteps.map(
        (step) =>
          step.code &&
          step.filename && (
            <div key={step.title} className="space-y-1">
              <span className="label">Hook config</span>
              <CodeBlock filename={step.filename} code={step.code} />
            </div>
          ),
      )}
    </div>
  );
}
