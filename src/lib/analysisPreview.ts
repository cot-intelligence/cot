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

export interface SampleRun {
  id: string;
  lensKey: string;
  sessionShortId: string;
  sessionTitle: string;
  when: string;
}

/** Past runs shown in the sidebar and on the Analysis page. */
export const SAMPLE_RUNS: SampleRun[] = [
  {
    id: 'run-1',
    lensKey: 'coach',
    sessionShortId: '9028f3d9',
    sessionTitle: 'i want to improve the search functionality what can i do?',
    when: '2h ago',
  },
  {
    id: 'run-2',
    lensKey: 'debugger',
    sessionShortId: '8b1f3b2c',
    sessionTitle: 'fix the flaky import test in the collector',
    when: 'Yesterday',
  },
  {
    id: 'run-3',
    lensKey: 'cost',
    sessionShortId: 'a15774e0',
    sessionTitle: 'is this a good idea to have different color themes?',
    when: 'Yesterday',
  },
  {
    id: 'run-4',
    lensKey: 'security',
    sessionShortId: '7eb89210',
    sessionTitle: 'why am i not getting this data in cot?',
    when: '3 days ago',
  },
];

export function lensFor(key: string): AnalysisLens {
  return LENSES.find((l) => l.key === key) ?? LENSES[0];
}

export function runFor(id: string | undefined): SampleRun | undefined {
  return SAMPLE_RUNS.find((r) => r.id === id);
}
