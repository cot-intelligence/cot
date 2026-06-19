export type AgentId = 'claude' | 'cursor' | 'codex';

export interface SetupStep {
  tag: string;
  title: string;
  detail: string;
  kind: 'shell' | 'file';
  command?: string;
  filename?: string;
  code?: string;
}

export interface Agent {
  id: AgentId;
  name: string;
  product: string;
  tagline: string;
  events: string[];
  steps: SetupStep[];
}

const HOOK_CMD = (source: AgentId) => `cot hook ${source}`;

export const HOOK_LABELS: Record<string, string> = {
  SessionStart: 'Session start',
  SessionEnd: 'Session end',
  UserPromptSubmit: 'Prompt submitted',
  PreToolUse: 'Tool start',
  PostToolUse: 'Tool finish',
  PostToolUseFailure: 'Tool failed',
  Stop: 'Session stopped',
  SubagentStart: 'Subagent start',
  SubagentStop: 'Subagent finish',
  PreCompact: 'Compaction start',
  PostCompact: 'Compaction finish',
  Notification: 'Notification',
  PermissionRequest: 'Permission requested',
  sessionStart: 'Session start',
  sessionEnd: 'Session end',
  beforeSubmitPrompt: 'Prompt submitted',
  afterAgentResponse: 'Response',
  afterAgentThought: 'Thought',
  preToolUse: 'Tool start',
  postToolUse: 'Tool finish',
  postToolUseFailure: 'Tool failed',
  subagentStart: 'Subagent start',
  subagentStop: 'Subagent finish',
  preCompact: 'Compaction start',
  stop: 'Session stopped',
};

export function hookLabel(name: string): string {
  return HOOK_LABELS[name] ?? name;
}

const CLAUDE_HOOKS = `{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('claude')}" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('claude')}" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('claude')}" }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "${HOOK_CMD('claude')}" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "${HOOK_CMD('claude')}" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "${HOOK_CMD('claude')}" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('claude')}" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('claude')}" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('claude')}" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('claude')}" }] }]
  }
}`;

const CURSOR_HOOKS = `{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "${HOOK_CMD('cursor')}" }],
    "sessionEnd": [{ "command": "${HOOK_CMD('cursor')}" }],
    "beforeSubmitPrompt": [{ "command": "${HOOK_CMD('cursor')}" }],
    "afterAgentResponse": [{ "command": "${HOOK_CMD('cursor')}" }],
    "afterAgentThought": [{ "command": "${HOOK_CMD('cursor')}" }],
    "preToolUse": [{ "command": "${HOOK_CMD('cursor')}" }],
    "postToolUse": [{ "command": "${HOOK_CMD('cursor')}" }],
    "postToolUseFailure": [{ "command": "${HOOK_CMD('cursor')}" }],
    "subagentStart": [{ "command": "${HOOK_CMD('cursor')}" }],
    "subagentStop": [{ "command": "${HOOK_CMD('cursor')}" }],
    "preCompact": [{ "command": "${HOOK_CMD('cursor')}" }],
    "stop": [{ "command": "${HOOK_CMD('cursor')}" }]
  }
}`;

const CODEX_HOOKS = `{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('codex')}" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('codex')}" }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "${HOOK_CMD('codex')}" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "${HOOK_CMD('codex')}" }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "${HOOK_CMD('codex')}" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('codex')}" }] }],
    "PostCompact": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('codex')}" }] }],
    "SubagentStart": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "${HOOK_CMD('codex')}" }] }],
    "SubagentStop": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "${HOOK_CMD('codex')}" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "${HOOK_CMD('codex')}" }] }]
  }
}`;

const INSTALL_STEP: SetupStep = {
  tag: 'BRIDGE',
  title: 'Install the cot bridge',
  detail:
    'Installs the bridge and asks which agents to wire up — it writes the hook config for you. No accounts, no network egress.',
  kind: 'shell',
  command: 'curl -fsSL http://localhost:8000/install.sh | sh',
};

export const AGENTS: Agent[] = [
  {
    id: 'claude',
    name: 'Claude',
    product: 'Claude Code',
    tagline:
      'Capture every tool call, prompt, and stop event from Claude Code. Hooks fire in-process, so traces stay complete even when a session crashes.',
    events: [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PreCompact',
      'SubagentStop',
      'Stop',
      'SessionEnd',
    ],
    steps: [INSTALL_STEP, {
      tag: 'SETTINGS',
      title: 'Register the hooks',
      detail:
        'Add cot to your Claude Code settings. Each event pipes its JSON payload to the bridge over stdin.',
      kind: 'file',
      filename: '~/.claude/settings.json',
      code: CLAUDE_HOOKS,
    }],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    product: 'Cursor',
    tagline:
      'Trace prompts, shell runs, file edits, MCP calls, and agent responses from every Cursor session. Hooks run on the lifecycle bus, so nothing is sampled or dropped.',
    events: [
      'sessionStart',
      'beforeSubmitPrompt',
      'afterAgentResponse',
      'afterAgentThought',
      'preToolUse',
      'postToolUse',
      'postToolUseFailure',
      'subagentStart',
      'subagentStop',
      'preCompact',
      'stop',
      'sessionEnd',
    ],
    steps: [INSTALL_STEP, {
      tag: 'HOOKS',
      title: 'Register the hooks',
      detail:
        'Drop a hooks file in your Cursor config. cot reads each event from stdin and forwards the trace.',
      kind: 'file',
      filename: '~/.cursor/hooks.json',
      code: CURSOR_HOOKS,
    }],
  },
  {
    id: 'codex',
    name: 'Codex',
    product: 'Codex',
    tagline:
      "Trace prompts, shell runs, apply_patch edits, and MCP calls from Codex's lifecycle hook engine. Events stream over stdin, so every turn lands in full.",
    events: [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'PreCompact',
      'SubagentStop',
      'Stop',
    ],
    steps: [INSTALL_STEP, {
      tag: 'HOOKS',
      title: 'Register the hooks',
      detail:
        'Drop a hooks file in your Codex config, then run /hooks in Codex to review and trust it. cot reads each event from stdin and forwards the trace.',
      kind: 'file',
      filename: '~/.codex/hooks.json',
      code: CODEX_HOOKS,
    }],
  },
];

export function getAgent(id: AgentId): Agent {
  const found = AGENTS.find((a) => a.id === id);
  if (!found) throw new Error(`Unknown agent: ${id}`);
  return found;
}
