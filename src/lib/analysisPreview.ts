// Sample data for the Analysis design preview. The feature is not built yet:
// nothing here reads a real session or calls a model.

export type FindingSeverity = 'critical' | 'warn' | 'info';

export interface AnalysisFinding {
  severity: FindingSeverity;
  title: string;
  detail: string;
  /** Turns the finding cites; real results will link these into the Timeline. */
  turns: string[];
}

export interface AnalysisLens {
  key: string;
  name: string;
  blurb: string;
  verdict: string;
  findings: AnalysisFinding[];
}

export const LENSES: AnalysisLens[] = [
  {
    key: 'coach',
    name: 'Prompt coach',
    blurb: 'How you asked, and how to ask so the agent gets it right the first time.',
    verdict:
      'Most turns were well scoped. Three vague follow-ups caused about a third of the rework, and the same missing constraint was re-explained twice.',
    findings: [
      {
        severity: 'warn',
        title: 'Constraint restated after the agent ignored it',
        detail:
          '"Keep the API backwards compatible" was said in turn 2, then again in turns 9 and 14 after the agent changed a response shape. State it up front, or put it in a project rules file.',
        turns: ['T2', 'T9', 'T14'],
      },
      {
        severity: 'info',
        title: 'Vague follow-up led to a 12-minute detour',
        detail:
          '"Make it better" in turn 7 was read as a refactor of three unrelated files. Naming the target ("cut the p95 of /search") would have avoided it.',
        turns: ['T7', 'T8'],
      },
    ],
  },
  {
    key: 'debugger',
    name: 'Agent debugger',
    blurb: 'Where the agent got stuck, looped, or went off track, and why.',
    verdict:
      'The agent retried the same failing test command five times before reading the error. One wrong assumption about the config loader cost most of the session.',
    findings: [
      {
        severity: 'critical',
        title: 'Retry loop on an unchanged failing command',
        detail:
          'pytest ran 5 times with identical arguments and an identical import error. No file was read between runs until the sixth attempt.',
        turns: ['T11', 'T12', 'T13'],
      },
      {
        severity: 'warn',
        title: 'Edited a file it had not read',
        detail: 'settings.py was changed in turn 6 from memory of a similar project. The edit was reverted in turn 10.',
        turns: ['T6', 'T10'],
      },
    ],
  },
  {
    key: 'cost',
    name: 'Cost optimizer',
    blurb: 'What made the session expensive and what would have cut it.',
    verdict:
      'About 70% of spend came from re-reading large files that had not changed. Two long shell outputs stayed in context for 40 turns.',
    findings: [
      {
        severity: 'warn',
        title: 'Same 2,400-line file read 9 times',
        detail: 'No edits between reads. Keeping the relevant excerpt in the plan would have saved about $1.10.',
        turns: ['T4', 'T8', 'T15'],
      },
      {
        severity: 'info',
        title: 'Cache dropped after a mid-session model switch',
        detail: 'Switching models in turn 12 invalidated the prompt cache and re-billed the full prefix.',
        turns: ['T12'],
      },
    ],
  },
  {
    key: 'security',
    name: 'Security reviewer',
    blurb: 'Risky commands, secrets touched, and permissions the agent used.',
    verdict:
      'No destructive commands. One .env file was read into context, and one package was installed without a pinned version.',
    findings: [
      {
        severity: 'critical',
        title: 'Secrets file read into model context',
        detail: '.env was opened in turn 5, so its values reached the model provider. Consider a deny rule for env files.',
        turns: ['T5'],
      },
      {
        severity: 'info',
        title: 'Unpinned dependency installed',
        detail: '`pip install httpx` resolved to whatever release was latest at run time.',
        turns: ['T13'],
      },
    ],
  },
  {
    key: 'manager',
    name: 'Engineering manager',
    blurb: 'A plain-language recap: what shipped, what is left, and how it went.',
    verdict:
      'Shipped the search pagination fix with tests. Two follow-ups remain: the cursor format is undocumented and the slow query still needs an index.',
    findings: [
      {
        severity: 'info',
        title: 'Delivered: cursor-based pagination on /search',
        detail: '4 files changed and 11 tests added, all passing at the end of the session.',
        turns: ['T16'],
      },
      {
        severity: 'warn',
        title: 'Open: no index on the sort column',
        detail: 'The agent flagged it in turn 15 and deferred it. Worth a ticket.',
        turns: ['T15'],
      },
    ],
  },
];

/** A question asked about a finished run, and the analysis model's answer. */
export interface FollowUp {
  question: string;
  when: string;
  answer: string;
  /** Turns the answer cites. */
  evidence: string[];
  /** Optional short list the answer breaks out, e.g. the retried commands. */
  points?: string[];
}

export type RunGroup = 'Today' | 'Yesterday' | 'Earlier this week' | 'Last week';

export interface SampleRun {
  id: string;
  lensKey: string;
  sessionShortId: string;
  sessionTitle: string;
  group: RunGroup;
  when: string;
  /** Free-text question, for runs made with the custom lens. */
  customQuestion?: string;
  followUps?: FollowUp[];
}

/** Past runs listed in the Analysis library. */
export const SAMPLE_RUNS: SampleRun[] = [
  {
    id: 'run-1',
    lensKey: 'coach',
    sessionShortId: '9028f3d9',
    sessionTitle: 'i want to improve the search functionality what can i do?',
    group: 'Today',
    when: '2h ago',
  },
  {
    id: 'run-2',
    lensKey: 'debugger',
    sessionShortId: '8b1f3b2c',
    sessionTitle: 'fix the flaky import test in the collector',
    group: 'Today',
    when: '5h ago',
    followUps: [
      {
        question: 'Why did it keep rerunning pytest instead of reading the error?',
        when: '4h ago',
        answer:
          'Each failure printed the same ImportError, but the agent read it as a flaky test because the first run had passed locally in turn 9. It only opened the traceback after you wrote "stop rerunning it" in turn 13.',
        evidence: ['T9', 'T11', 'T13'],
      },
      {
        question: 'What would have caught this earlier?',
        when: '4h ago',
        answer: 'Three things, in order of how much time they would have saved:',
        evidence: ['T6', 'T11'],
        points: [
          'A project rule to read the traceback before any rerun (saves about 9 minutes here).',
          'Running the single failing test instead of the whole suite, so each retry took 4s instead of 40s.',
          'Reading settings.py before editing it in turn 6, which caused the import error in the first place.',
        ],
      },
    ],
  },
  {
    id: 'run-3',
    lensKey: 'cost',
    sessionShortId: 'a15774e0',
    sessionTitle: 'is this a good idea to have different color themes?',
    group: 'Yesterday',
    when: '18:40',
  },
  {
    id: 'run-4',
    lensKey: 'security',
    sessionShortId: '7eb89210',
    sessionTitle: 'why am i not getting this data in cot?',
    group: 'Yesterday',
    when: '11:05',
  },
  {
    id: 'run-5',
    lensKey: 'manager',
    sessionShortId: '3c9e0d41',
    sessionTitle: 'ship the v1.9.0 release notes and tag',
    group: 'Earlier this week',
    when: 'Tue',
  },
  {
    id: 'run-6',
    lensKey: 'coach',
    sessionShortId: 'f02a7b66',
    sessionTitle: 'add session replay import from exported json',
    group: 'Earlier this week',
    when: 'Mon',
    customQuestion: 'Did the agent follow our testing conventions?',
  },
  {
    id: 'run-7',
    lensKey: 'debugger',
    sessionShortId: '51d8c3aa',
    sessionTitle: 'tauri app does not start the collector on boot',
    group: 'Last week',
    when: 'Sep 17',
  },
];

export const RUN_GROUPS: RunGroup[] = ['Today', 'Yesterday', 'Earlier this week', 'Last week'];

export function lensFor(key: string): AnalysisLens {
  return LENSES.find((l) => l.key === key) ?? LENSES[0];
}

export function runFor(id: string | undefined): SampleRun | undefined {
  return SAMPLE_RUNS.find((r) => r.id === id);
}

export function severityCounts(findings: AnalysisFinding[]): Record<FindingSeverity, number> {
  const counts = { critical: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

// --- Across all sessions ---

export type ImprovementArea = 'Prompting' | 'Agent behaviour' | 'Cost' | 'Security';

export interface Improvement {
  title: string;
  area: ImprovementArea;
  impact: 'High' | 'Medium' | 'Low';
  /** Sessions the pattern showed up in, out of the report's `sessions`. */
  seenIn: number;
  trend: 'rising' | 'falling' | 'steady';
  detail: string;
  fix: string;
  /** Short ids of example sessions; real results link to each one. */
  examples: string[];
}

export interface AcrossReport {
  sessions: number;
  projects: number;
  lastRun: string;
  stats: [label: string, value: string][];
  improvements: Improvement[];
  strengths: string[];
}

export const ACROSS_REPORT: AcrossReport = {
  sessions: 48,
  projects: 3,
  lastRun: '2 days ago',
  stats: [
    ['Sessions read', '48'],
    ['Patterns found', '6'],
    ['Rework turns', '14%'],
    ['Avoidable spend', '~$38 / mo'],
  ],
  improvements: [
    {
      title: 'Constraints are stated late, then repeated',
      area: 'Prompting',
      impact: 'High',
      seenIn: 17,
      trend: 'rising',
      detail:
        'Rules like "keep the API backwards compatible" or "no new dependencies" usually arrive after the agent has already broken them, and get repeated 2 to 3 times per session.',
      fix: 'Move the five most repeated rules into CLAUDE.md / AGENTS.md. They cover 80% of the repeats.',
      examples: ['9028f3d9', 'a15774e0', '3c9e0d41'],
    },
    {
      title: 'Test failures retried without reading the error',
      area: 'Agent behaviour',
      impact: 'High',
      seenIn: 11,
      trend: 'steady',
      detail:
        'The agent reruns the same failing test command 3 or more times before opening the failing file. It happens most with pytest import errors.',
      fix: 'Add a project rule: "after a failing test, read the traceback and the failing file before rerunning".',
      examples: ['8b1f3b2c', '51d8c3aa'],
    },
    {
      title: 'Large unchanged files re-read many times',
      area: 'Cost',
      impact: 'Medium',
      seenIn: 22,
      trend: 'falling',
      detail:
        'Files over 1,500 lines are read on average 6 times per session with no edits in between. This is the single biggest source of input tokens.',
      fix: 'Split api.ts and SettingsView.tsx. Ask for a plan that names the exact functions to touch.',
      examples: ['a15774e0', '9028f3d9', 'f02a7b66'],
    },
    {
      title: 'Env files read into context',
      area: 'Security',
      impact: 'High',
      seenIn: 4,
      trend: 'steady',
      detail: '.env and config.json files with tokens were opened in 4 sessions, so their values reached the model provider.',
      fix: 'Add a deny rule for **/.env* and ~/.cot/config.json in your agent permissions.',
      examples: ['7eb89210', '51d8c3aa'],
    },
    {
      title: 'Vague follow-ups cause detours',
      area: 'Prompting',
      impact: 'Medium',
      seenIn: 9,
      trend: 'falling',
      detail: '"Make it better" and "fix it" style follow-ups lead to edits outside the area you meant, about 10 minutes each.',
      fix: 'Name the target and the success check, e.g. "cut the p95 of /search below 200ms".',
      examples: ['9028f3d9', 'f02a7b66'],
    },
    {
      title: 'Model switched mid-session',
      area: 'Cost',
      impact: 'Low',
      seenIn: 6,
      trend: 'steady',
      detail: 'Each switch drops the prompt cache and re-bills the full context.',
      fix: 'Pick the model at the start; open a new session to change it.',
      examples: ['3c9e0d41'],
    },
  ],
  strengths: [
    'Plans before large changes in 70% of sessions, and those sessions need half as many rework turns.',
    'Tests are added alongside fixes in most release work.',
    'Sessions stay focused: 85% cover a single task.',
  ],
};
