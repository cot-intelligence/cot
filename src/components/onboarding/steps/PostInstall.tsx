import { getAgent, type AgentId } from '../../../lib/agents';
import { Icon } from '../../forest/icons';
import { HistorySummary, useImportHistory } from './HistorySummary';
import { Actions, Shell, StatusRow } from './Shell';

interface PostInstallProps {
  agents: AgentId[];
  onFinish: (origin: { x: number; y: number }) => void;
}

/** Shown when the install script already wired the hooks: nothing to choose, just what's connected and found. */
export function PostInstall({ agents, onFinish }: PostInstallProps) {
  const { summary, state } = useImportHistory();
  return (
    <Shell
      eyebrow="Installed"
      title="You’re all set"
      lead="cot is installed and your hooks are connected. Sessions from your agents appear in the dashboard as they happen.">
      <ul className="onb-status">
        {agents.map((id) => (
          <StatusRow key={id} id={id} name={getAgent(id).product} tone="ok" status="Connected" />
        ))}
      </ul>
      <HistorySummary summary={summary} state={state} />
      <p className="onb-note"><Icon name="clock" size={14} />Transcript import turns on too when you continue, for agents without a hook.</p>
      <Actions next={{ label: 'Open dashboard', onClick: onFinish }} />
    </Shell>
  );
}
