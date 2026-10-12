/**
 * The sentence builder's model ("Tell me when any agent runs a command that
 * contains npm install") and its two-way mapping to a rule spec.
 *
 * The spec (backend/app/user_rules.py) stays the one source of truth; this is a
 * friendlier view of the subset of specs a sentence can express. `fromSpec`
 * returns null for anything outside that subset, and the editor falls back to
 * the advanced form for it, so nothing a user wrote is ever silently changed.
 */
import type { InsightPillar, InsightSeverity, RuleCondition, RuleLeaf, RuleSpec } from './api';

export type VerbKey = 'shell' | 'read' | 'edit' | 'web' | 'mcp' | 'any' | 'spend';

export interface Verb {
  key: VerbKey;
  label: string;
  /** Activity types this verb means; null = no category condition. */
  categories: string[] | null;
  /** The fields a condition can be about, first is the default. */
  about: { field: string; label: string }[];
  /** Default pillar for an auto-filled rule. */
  pillar: InsightPillar;
  /** Noun for the auto-generated name and the examples heading. */
  noun: string;
}

export const VERBS: Verb[] = [
  { key: 'shell', label: 'runs a command', categories: ['shell'], about: [{ field: 'target', label: 'the command' }, { field: 'program', label: 'the program' }], pillar: 'security', noun: 'command' },
  { key: 'read', label: 'reads a file', categories: ['file_read', 'context_read'], about: [{ field: 'target', label: 'the path' }], pillar: 'security', noun: 'file' },
  { key: 'edit', label: 'edits a file', categories: ['file_edit'], about: [{ field: 'target', label: 'the path' }], pillar: 'security', noun: 'file' },
  { key: 'web', label: 'goes to the web', categories: ['web'], about: [{ field: 'target', label: 'the URL or search' }], pillar: 'security', noun: 'request' },
  {
    key: 'mcp',
    label: 'calls an MCP tool',
    categories: ['mcp'],
    about: [{ field: 'mcp_server', label: 'the server' }, { field: 'tool', label: 'the tool' }, { field: 'target', label: 'the input' }],
    pillar: 'usability',
    noun: 'call',
  },
  { key: 'any', label: 'does anything', categories: null, about: [{ field: 'target', label: 'the command, path or URL' }, { field: 'tool', label: 'the tool' }], pillar: 'security', noun: 'event' },
  { key: 'spend', label: 'spends more than', categories: null, about: [], pillar: 'cost', noun: 'session' },
];

export const verbOf = (k: VerbKey) => VERBS.find((v) => v.key === k)!;

/** Operators offered in the sentence, in plain words. `none` ones take no value. */
export const SIMPLE_OPS: { op: string; label: string; none?: boolean; only?: VerbKey[] }[] = [
  { op: 'contains', label: 'contains' },
  { op: 'starts_with', label: 'starts with' },
  { op: 'ends_with', label: 'ends with' },
  { op: 'eq', label: 'is exactly' },
  { op: 'glob', label: 'matches pattern' },
  { op: 'not_contains', label: "doesn't contain" },
  { op: 'is_risky_command', label: 'is a risky command', none: true, only: ['shell', 'any'] },
  { op: 'is_sensitive_path', label: 'is a sensitive file', none: true, only: ['read', 'edit', 'any'] },
  { op: 'outside_project', label: 'is outside the project', none: true, only: ['read', 'edit'] },
  { op: 'regex', label: 'matches regex' },
];

export function opsFor(verb: VerbKey, field: string) {
  return SIMPLE_OPS.filter((o) => (!o.only || o.only.includes(verb)) && (!o.none || field === 'target'));
}

export const PER: Record<string, string> = {
  '': 'in total',
  session: 'per session',
  project: 'per project',
  source: 'per agent',
  target: 'per command, path or URL',
  program: 'per program',
  mcp_server: 'per server',
  tool: 'per tool',
};

export interface Sentence {
  agent: string; // '' = any agent
  verb: VerbKey;
  join: 'and' | 'or';
  conds: RuleLeaf[];
  fails: boolean;
  /** "at least N times per …" — a threshold rule. */
  limit: { count: number; per: string } | null;
  /** The spend verb's budget. */
  budget: { amount: number; per: string };
  projects: string[];
  name: string;
  /** False while the name is auto-generated, so it follows the sentence. */
  nameTouched: boolean;
  severity: InsightSeverity;
  pillar: InsightPillar;
  pillarTouched: boolean;
  recommendation: string;
  /** What one finding is about; kept from the spec, else the verb's first field. */
  subject?: string;
}

export function blankSentence(verb: VerbKey = 'shell'): Sentence {
  const v = verbOf(verb);
  return {
    agent: '',
    verb,
    join: 'and',
    conds: v.about.length ? [{ field: v.about[0].field, op: 'contains', value: '' }] : [],
    fails: false,
    limit: null,
    budget: { amount: 5, per: 'session' },
    projects: [],
    name: '',
    nameTouched: false,
    severity: 'warn',
    pillar: v.pillar,
    pillarTouched: false,
    recommendation: '',
  };
}

const opLabel = (op: string) => SIMPLE_OPS.find((o) => o.op === op)?.label ?? op;

const filled = (c: RuleLeaf) =>
  SIMPLE_OPS.find((o) => o.op === c.op)?.none || (c.value !== undefined && String(c.value).trim() !== '');

/**
 * Whether the sentence says what to look for. Until it does, the rule would
 * match everything of its kind ("Agent runs a command"), so there is nothing
 * worth previewing or saving yet. A budget, a failure, or one filled-in
 * condition each make it specific; agent, projects and repeat limits narrow a
 * rule but don't say what it is about.
 */
export function isSpecific(s: Sentence): boolean {
  return s.verb === 'spend' || s.fails || s.conds.some(filled);
}

/** "Agent runs a command that contains npm install, at least 3 times per session". */
export function autoName(s: Sentence): string {
  const v = verbOf(s.verb);
  if (s.verb === 'spend') return `Spends more than $${s.budget.amount} ${PER[s.budget.per] ?? ''}`.trim();
  const about = s.conds.filter(filled).map((c) => {
    const field = v.about.find((a) => a.field === c.field)?.label.replace(/^the /, '') ?? c.field;
    const val = SIMPLE_OPS.find((o) => o.op === c.op)?.none ? '' : ` ${String(c.value)}`;
    return `${field} ${opLabel(c.op)}${val}`;
  });
  let name = `Agent ${v.label}`;
  if (about.length) name += ` where ${about.join(s.join === 'or' ? ' or ' : ' and ')}`;
  if (s.fails) name += ', and it fails';
  if (s.limit) name += `, ${s.limit.count}+ times ${PER[s.limit.per] ?? ''}`.trimEnd();
  return name.length > 120 ? `${name.slice(0, 117)}…` : name;
}

function categoryLeaf(v: Verb): RuleLeaf | null {
  if (!v.categories) return null;
  return v.categories.length === 1
    ? { field: 'category', op: 'eq', value: v.categories[0] }
    : { field: 'category', op: 'in', value: v.categories };
}

export function toSpec(s: Sentence): RuleSpec {
  const v = verbOf(s.verb);
  const base = {
    name: (s.nameTouched && s.name.trim()) || autoName(s),
    pillar: s.pillarTouched ? s.pillar : s.fails ? 'usability' : v.pillar,
    severity: s.severity,
    scope: { sources: s.agent ? [s.agent] : [], projects: s.projects },
    recommendation: s.recommendation,
    action: 'finding' as const,
  };
  if (s.verb === 'spend') {
    return {
      ...base,
      type: 'threshold',
      when: { all: [{ field: 'tokens', op: 'gt', value: 0 }] },
      threshold: { group_by: s.budget.per ? [s.budget.per] : [], aggregate: 'sum', field: 'cost_usd', op: 'gte', value: s.budget.amount },
    };
  }
  const all: RuleCondition[] = [];
  const cat = categoryLeaf(v);
  if (cat) all.push(cat);
  if (s.fails) all.push({ field: 'status', op: 'eq', value: 'error' });
  const conds = s.conds.filter(filled).map(({ field, op, value }) => (SIMPLE_OPS.find((o) => o.op === op)?.none ? { field, op } : { field, op, value }));
  if (s.join === 'or' && conds.length > 1) all.push({ any: conds });
  else all.push(...conds);
  // A rule needs one condition; "does anything" with nothing else matches every event.
  if (!all.length) all.push({ field: 'category', op: 'exists' });
  const when: RuleCondition = { all };
  if (s.limit) {
    return {
      ...base,
      type: 'threshold',
      when,
      threshold: { group_by: s.limit.per ? [s.limit.per] : [], aggregate: 'count', op: 'gte', value: s.limit.count },
    };
  }
  return { ...base, type: 'match', when, subject: s.subject ?? v.about[0]?.field ?? 'target' };
}

const isLeaf = (c: RuleCondition): c is RuleLeaf => 'field' in c;

function categoriesOf(leaf: RuleLeaf): string[] | null {
  if (leaf.field !== 'category') return null;
  if (leaf.op === 'eq' && typeof leaf.value === 'string') return [leaf.value];
  if (leaf.op === 'in' && Array.isArray(leaf.value)) return [...leaf.value];
  return null;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The sentence a spec reads as, or null when it needs the advanced editor. */
export function fromSpec(spec: RuleSpec): Sentence | null {
  const sources = spec.scope?.sources ?? [];
  if (sources.length > 1 || (spec.action && spec.action !== 'finding')) return null;
  const common = {
    agent: sources[0] ?? '',
    projects: spec.scope?.projects ?? [],
    name: spec.name ?? '',
    nameTouched: Boolean(spec.name?.trim()),
    severity: spec.severity ?? 'warn',
    pillar: spec.pillar ?? 'security',
    pillarTouched: true,
    recommendation: spec.recommendation ?? '',
    subject: spec.type === 'match' ? spec.subject : undefined,
  };
  const t = spec.threshold;
  const items = !spec.when ? null : isLeaf(spec.when) ? [spec.when] : 'all' in spec.when ? spec.when.all : null;
  if (!items) return null;

  // The spend shape: tokens > 0, summed cost per group.
  if (spec.type === 'threshold' && t?.aggregate === 'sum') {
    const ok = t.field === 'cost_usd' && (t.op === 'gte' || t.op === 'gt') && t.group_by.length <= 1
      && items.length === 1 && isLeaf(items[0]) && items[0].field === 'tokens' && items[0].op === 'gt';
    if (!ok) return null;
    return { ...blankSentence('spend'), ...common, budget: { amount: t.value, per: t.group_by[0] ?? '' } };
  }

  let verb: Verb | undefined;
  let fails = false;
  let join: 'and' | 'or' = 'and';
  const conds: RuleLeaf[] = [];
  const rest: RuleCondition[] = [];
  for (const c of items) {
    const cats = isLeaf(c) ? categoriesOf(c) : null;
    if (cats && !verb) {
      verb = VERBS.find((v) => v.categories && sameSet(v.categories, cats));
      if (!verb) return null;
    } else if (isLeaf(c) && c.field === 'status' && c.op === 'eq' && c.value === 'error') fails = true;
    else if (isLeaf(c) && c.field === 'category' && c.op === 'exists') continue;
    else rest.push(c);
  }
  verb ??= verbOf('any');
  for (const c of rest) {
    if (isLeaf(c)) conds.push(c);
    else if ('any' in c && c.any.every(isLeaf) && join === 'and' && rest.length === 1) {
      join = 'or';
      conds.push(...(c.any as RuleLeaf[]));
    } else return null;
  }
  const v = verb;
  if (!conds.every((c) => v.about.some((a) => a.field === c.field) && opsFor(v.key, c.field).some((o) => o.op === c.op))) return null;

  let limit: Sentence['limit'] = null;
  if (spec.type === 'threshold') {
    if (!t || t.aggregate !== 'count' || t.group_by.length > 1 || !(t.op === 'gte' || t.op === 'gt')) return null;
    const per = t.group_by[0] ?? '';
    if (!(per in PER)) return null;
    limit = { count: t.op === 'gt' ? Math.floor(t.value) + 1 : t.value, per };
  }
  return {
    ...blankSentence(v.key),
    ...common,
    verb: v.key,
    join,
    conds: conds.length ? conds : blankSentence(v.key).conds,
    fails,
    limit,
  };
}
