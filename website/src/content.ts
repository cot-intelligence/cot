export const site = {
  name: 'cot.',
  title: 'cot. - Agent Observability for Coding Agents',
  tagline: 'Agent observability for Claude, Cursor, and Codex. Self-hosted.',
  repo: '0xcardinal/cot',
  github: 'https://github.com/0xcardinal/cot',
  dockerImage: 'ghcr.io/cot-intelligence/cot:latest',
  dashboardUrl: 'http://localhost:8000',
} as const;

export const nav = {
  links: [
    { label: 'Docs', href: '/docs' },
    { label: 'Contact', href: '/contact' },
  ],
  cta: { label: 'Get started', href: '/docs' },
} as const;

export const hero = {
  badge: 'cot v1.0 is live',
  headline: ['See how', 'agents think.'],
  callout:
    'Self-hosted observability for AI coding agents. Trace sessions, browse timelines, search traces — locally.',
  ghostCta: 'Read the docs',
  dockerLabel: 'Install in one command',
} as const;

export const marquee = {
  pin: '100% FREE',
  facts: [
    'SESSION TRACES',
    'TOOL CALLS',
    'LOCAL SEARCH',
    'USAGE METRICS',
    'CLAUDE · CURSOR · CODEX',
    'SELF-HOSTED',
  ],
} as const;

export const pillars = {
  label: 'OUTCOMES',
  heading: 'Built for Engineers',
  items: [
    {
      num: '01',
      title: 'Trace sessions.',
      description:
        'Every prompt, tool call, and response — captured automatically from Claude Code, Cursor, or Codex via local hooks.',
    },
    {
      num: '02',
      title: 'Understand usage.',
      description:
        'See which tools, models, and patterns your agents use across projects. Metrics and timelines, not guesswork.',
    },
    {
      num: '03',
      title: 'Stay local.',
      description:
        'Traces live in SQLite on your machine. Browse, search, and review sessions in a dashboard you control.',
    },
  ],
} as const;

export const depth = {
  label: 'SYSTEM_DEPTH',
  heading: ['Visibility for', 'every event.'],
  callout:
    'From prompt to tool call to response — follow the full session timeline. Drill into individual events and raw hook payloads.',
  trace: {
    id: 'sess_4c21e8',
    latency: '2.41s',
    cost: '570 tokens',
    eval: 'claude · cursor',
    spans: [
      { name: 'Session.Start', duration: '12ms', width: '8%', color: 'cream' as const },
      { name: 'Tool.Shell', duration: '820ms', width: '30%', color: 'cream' as const, nested: true },
      { name: 'Tool.FileEdit', duration: '340ms', width: '18%', color: 'cream' as const, nested: true },
      {
        name: 'Agent.Response',
        duration: '1.45s',
        width: '55%',
        color: 'vermilion' as const,
        nested: true,
        tooltip: 'PRMT: 450t | COMP: 120t',
      },
    ],
  },
} as const;

export const capabilities = {
  label: 'CAPABILITIES',
  heading: 'Understand your agents',
  items: [
    {
      label: 'SESSIONS',
      title: 'Session browser.',
      description:
        'Browse every agent session by project, source, and status. Archive old runs, filter by agent, and jump into any trace.',
      panel: {
        header: 'SESSION_LIST',
        context: 'live',
        cells: [
          { label: 'ACTIVE', value: '3 sessions', accent: 'olive' as const },
          { label: 'SOURCES', value: 'claude·cursor' },
          { label: 'PROJECTS', value: '4', accent: 'cobalt' as const },
          { label: 'EVENTS_24H', value: '1,284', accent: 'vermilion' as const },
        ],
      },
    },
    {
      label: 'TIMELINE',
      title: 'Event timelines.',
      description:
        'Follow prompts, tool calls, shell commands, file edits, and responses in chronological order. Merged spans show start-to-finish.',
      panel: {
        header: 'TIMELINE',
        context: 'sess_4c21e8',
        cells: [
          { label: 'EVENTS', value: '47' },
          { label: 'TOOL_CALLS', value: '12', accent: 'cobalt' as const },
          { label: 'DURATION', value: '18m 42s' },
          { label: 'STATUS', value: 'COMPLETED', accent: 'olive' as const },
        ],
      },
    },
    {
      label: 'SEARCH',
      title: 'Local search.',
      description:
        'Search across all session events — prompts, commands, file paths, tool names. Cmd+K from anywhere in the dashboard.',
      panel: {
        header: 'SEARCH',
        context: 'local',
        cells: [
          { label: 'INDEX', value: 'LOCAL', accent: 'olive' as const },
          { label: 'SCOPE', value: 'all events' },
          { label: 'FIELDS', value: 'title·detail' },
          { label: 'LATENCY', value: '<50ms', accent: 'cobalt' as const },
        ],
      },
    },
    {
      label: 'METRICS',
      title: 'Usage metrics.',
      description:
        'Cross-session aggregates — tool frequency, model breakdown, token usage, estimated cost, error rates. See what your agents actually do.',
      panel: {
        header: 'METRICS',
        context: '7d',
        cells: [
          { label: 'TOP_TOOL', value: 'shell' },
          { label: 'SESSIONS', value: '42', accent: 'vermilion' as const },
          { label: 'AVG_TOKENS', value: '570/sess' },
          { label: 'SOURCES', value: '3 agents', accent: 'cobalt' as const },
        ],
      },
    },
    {
      label: 'HOOKS',
      title: 'Zero-config hooks.',
      description:
        'Install wires local hooks into Claude Code, Cursor, and Codex automatically. No SDK, no code changes — agents pipe events to a local bridge.',
      panel: {
        header: 'HOOK_STATUS',
        context: 'install',
        cells: [
          { label: 'CLAUDE', value: 'LIVE', accent: 'olive' as const },
          { label: 'CURSOR', value: 'LIVE', accent: 'olive' as const },
          { label: 'CODEX', value: 'LIVE', accent: 'olive' as const },
          { label: 'BRIDGE', value: '~/.cot/bin/cot' },
        ],
      },
    },
    {
      label: 'INSIGHTS',
      title: 'Session insights.',
      description:
        'Per-session stats — tool breakdown, token usage, estimated cost, duration, and category distribution. Understand what happened at a glance.',
      panel: {
        header: 'INSIGHTS',
        context: 'sess_4c21e8',
        cells: [
          { label: 'TOOLS', value: 'shell·edit·read' },
          { label: 'TOKENS', value: '2,840', accent: 'vermilion' as const },
          { label: 'ERRORS', value: '0', accent: 'olive' as const },
          { label: 'MODEL', value: 'claude-4' },
        ],
      },
    },
    {
      label: 'STORAGE',
      title: 'Local by default.',
      description:
        'All traces stored in ~/.cot/cot.db on your machine. Self-hosted collector in Docker. Optional aggregate usage metrics you can disable.',
      panel: {
        header: 'DATA_LOCAL',
        context: 'your machine',
        cells: [
          { label: 'DATABASE', value: '~/.cot/cot.db' },
          { label: 'COLLECTOR', value: 'DOCKER', accent: 'cobalt' as const },
          { label: 'ACCOUNTS', value: 'NONE', accent: 'olive' as const },
          { label: 'TELEMETRY', value: 'OPT-OUT', accent: 'vermilion' as const },
        ],
      },
    },
  ],
} as const;

export const install = {
  label: 'QUICKSTART // SELF-HOST',
  heading: 'One command. Docker up, agents wired.',
  command: 'curl -fsSL https://cot.run/install | sh',
  note: 'starts the collector in Docker, then wires up the agents you pick  ·  dashboard at ' + site.dashboardUrl,
} as const;

export const cta = {
  heading: 'The agent observability platform.',
  callout: 'Self-host. Free. Local traces by default.',
  button: 'Read the docs',
  href: '/docs',
} as const;

export const docsCta = {
  heading: 'Ready to trace your agents?',
  callout: 'One command. Docker up, agents wired.',
  button: 'Go to main site',
  href: '/',
} as const;

export const footer = {
  resources: [
    { label: 'Docs', href: '/docs' },
    { label: 'Starter Guide', href: '/docs/starter-guide' },
    { label: 'Why cot', href: '/docs/why-cot' },
    { label: 'FAQ', href: '/docs/faq' },
    { label: 'Contact', href: '/contact' },
  ],
  legal: 'SELF-HOSTED // FREE TO USE // LOCAL TRACES BY DEFAULT',
} as const;

export const contact = {
  label: 'CONTACT',
  heading: ['Talk to', 'us.'],
  callout: 'Feature request, feedback, or anything else — we read every message.',
  types: [
    { value: 'feature', label: 'Feature request' },
    { value: 'feedback', label: 'Feedback' },
    { value: 'other', label: 'Something else' },
  ],
  fields: {
    type: 'What is this about?',
    email: 'Email (optional)',
    message: 'Message',
  },
  emailPlaceholder: 'you@company.com',
  messagePlaceholder: 'Tell us what you need, what broke, or what would make cot better.',
  submit: 'Send message',
  submitting: 'Sending…',
  successTitle: 'Message received.',
  successBody: 'Thanks for reaching out. We read every submission.',
} as const;

export const traceViewer = {
  filename: 'trace_viewer',
  labels: [
    { text: 'prompt: fix auth bug', delay: 0.8 },
    { text: 'tool: file_read', delay: 1.1 },
    { text: 'tool: shell', delay: 1.3 },
    { text: 'agent: response', delay: 1.9, accent: true },
    { text: 'tool: file_edit', delay: 2.2 },
    { text: 'session: complete', delay: 2.5 },
  ],
  hud: [
    { label: 'SESSION_ID', value: 'sess_4c21e8' },
    { label: 'SOURCE', value: 'CLAUDE', accent: true },
    { label: 'EVENTS', value: '47' },
    { label: 'STATUS', value: 'LIVE' },
  ],
} as const;
