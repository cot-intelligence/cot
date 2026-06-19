import { site } from '../content';

export const docsNav = {
  links: [
    { label: 'Overview', href: '/docs' },
    { label: 'Starter guide', href: '/docs/starter-guide' },
    { label: 'Why cot', href: '/docs/why-cot' },
    { label: 'FAQ', href: '/docs/faq' },
  ],
} as const;

export const docsIndex = {
  label: 'DOCS',
  heading: ['See how', 'it works.'],
  callout:
    'Self-hosted agent observability. Install in one command, wire your agents, and browse sessions locally.',
  installCommand: 'curl -fsSL https://cot.run/install | sh',
  installNote: `dashboard at ${site.dashboardUrl}`,
  cards: [
    {
      num: '01',
      title: 'Trace sessions.',
      description:
        'Every prompt, tool call, and response — captured automatically from Claude Code, Cursor, or Codex.',
    },
    {
      num: '02',
      title: 'Browse locally.',
      description:
        'Sessions, timelines, search, and usage metrics — all in a dashboard running on your machine.',
    },
    {
      num: '03',
      title: 'Stay in control.',
      description:
        'Traces live in local SQLite. No accounts. Optional aggregate usage metrics you can turn off.',
    },
  ],
  agents: ['Claude Code', 'Cursor', 'Codex'],
  quickLinks: [
    { label: 'Starter guide', href: '/docs/starter-guide', desc: 'Install and connect agents' },
    { label: 'Why cot', href: '/docs/why-cot', desc: 'What it is and how it fits' },
    { label: 'FAQ', href: '/docs/faq', desc: 'Telemetry, data, troubleshooting' },
  ],
} as const;

export const starterGuide = {
  label: 'STARTER_GUIDE',
  heading: 'Up and running.',
  callout: 'One command installs the collector, bridge, and agent hooks.',
  prerequisites: ['Docker running', 'curl', 'Claude Code, Cursor, or Codex'],
  steps: [
    {
      num: '01',
      title: 'Install',
      body: 'Run the one-liner. Cot starts a local collector in Docker, downloads the bridge, and wires hooks.',
      command: 'curl -fsSL https://cot.run/install | sh',
    },
    {
      num: '02',
      title: 'Open dashboard',
      body: `Visit ${site.dashboardUrl}. A setup wizard walks you through agent selection and verification.`,
    },
    {
      num: '03',
      title: 'Use your agent',
      body: 'Work normally. Hooks fire in the background. Sessions appear in the dashboard within seconds.',
    },
  ],
  commands: [
    { label: 'STOP COLLECTOR', command: 'docker stop cot', desc: 'Pause the local collector' },
    {
      label: 'UPDATE BRIDGE',
      command: 'curl -fsSL http://localhost:8000/cot -o ~/.cot/bin/cot && chmod +x ~/.cot/bin/cot',
      desc: 'Refresh the local bridge script',
    },
  ],
  overrides: [
    { var: 'COT_PORT', desc: 'Host port for the collector (default 8000)' },
    { var: 'COT_AGENTS', desc: 'Agents to wire: claude, cursor, codex' },
    { var: 'COT_ENDPOINT', desc: 'Collector URL for the bridge' },
    { var: 'COT_DISABLE_TELEMETRY', desc: 'Set to 1 to disable outbound usage metrics' },
  ],
} as const;

export const whyCot = {
  label: 'WHY_COT',
  heading: ['What is', 'cot?'],
  callout:
    'Cot is a self-hosted observability layer for AI coding agents. It captures what your agents do — without changing how you work.',
  name: {
    title: 'Why "cot"?',
    body: 'Short for chain of thought — the visible trail of prompts, tool calls, and outputs that make up an agent session. Cot turns that trail into something you can browse, search, and understand.',
  },
  useCases: [
    {
      title: 'Debug agent runs.',
      body: 'See exactly which tools fired, what files were touched, and where a session went sideways.',
    },
    {
      title: 'Understand usage.',
      body: 'Track which agents, models, tools, tokens, and estimated spend you actually use across projects.',
    },
    {
      title: 'Review with context.',
      body: 'Share session timelines with teammates instead of scrolling through terminal output.',
    },
  ],
  architecture: {
    title: 'How it fits on your machine',
    steps: [
      { label: 'YOUR AGENT', value: 'Claude Code · Cursor · Codex', accent: 'cobalt' as const },
      { label: 'LOCAL BRIDGE', value: '~/.cot/bin/cot', accent: 'vermilion' as const },
      { label: 'COLLECTOR', value: 'FastAPI in Docker', accent: 'olive' as const },
      { label: 'STORAGE', value: '~/.cot/cot.db', accent: 'cobalt' as const },
      { label: 'DASHBOARD', value: 'localhost:8000', accent: 'vermilion' as const },
    ],
    collected: [
      'Prompts and agent responses',
      'Tool calls — shell, file edits, MCP, web search',
      'Session metadata — project path, model, timestamps',
      'Token counts (Claude sessions)',
    ],
    notCollected: [
      'No cloud accounts or logins',
      'No prompts or responses sent to cot.run by default',
      'No raw image bytes — attachment metadata only',
    ],
  },
} as const;

export const faq = {
  label: 'FAQ',
  heading: 'Common questions.',
  items: [
    {
      q: 'Do I need an account?',
      a: 'No. Cot is fully self-hosted. Install locally, open the dashboard, and start tracing.',
    },
    {
      q: 'Which agents are supported?',
      a: 'Claude Code, Cursor, and Codex. Hooks wire automatically during install.',
    },
    {
      q: 'Do I need to change my code?',
      a: 'No SDK required. Cot uses agent lifecycle hooks — your agents pipe events to a local bridge script.',
    },
    {
      q: 'Where is my data stored?',
      a: 'Locally in ~/.cot/cot.db (SQLite on your machine). The collector runs in Docker with your home directory mounted.',
    },
    {
      q: 'What telemetry does Cot collect?',
      a: 'Trace data stays local. Separately, Cot can send optional aggregate usage metrics to cot.run — session counts, event counts, installation timestamp, runtime info. No prompts, responses, file paths, or commands are included. This is on by default; turn it off in Settings → Usage metrics, or set COT_DISABLE_TELEMETRY=1.',
    },
    {
      q: 'Does Cot work offline?',
      a: 'Yes, for tracing. The collector and dashboard run locally. Install requires network access (Docker image pull, bridge download). Update checks and telemetry are optional and degrade silently when offline.',
    },
    {
      q: 'Is Docker required?',
      a: 'For the one-line install, yes. If you already run the collector elsewhere, install only the bridge: curl -fsSL http://localhost:8000/install.sh | sh',
    },
    {
      q: 'Port 8000 is already in use?',
      a: 'The installer finds the next free port automatically. Override with COT_PORT=9000.',
    },
    {
      q: 'Codex hooks not firing?',
      a: 'Run /hooks in Codex to review and trust the new hooks after install.',
    },
    {
      q: 'How do I know hooks are working?',
      a: 'Check Settings → Hook health, or open Reconfigure cot and use the Connect step.',
    },
    {
      q: 'Is Cot open source?',
      a: 'Not open source — but free to self-host and use, no catch. The code ships inside the Docker image if you\'re the type who needs to peek under the hood. We hope that\'s enough.',
    },
    {
      q: 'How do I stop or remove Cot?',
      a: 'Stop the collector with docker stop cot. Remove hook entries from agent config files (backups are timestamped as *.cot-*.bak). Delete ~/.cot/ to remove all local data.',
    },
  ],
} as const;
