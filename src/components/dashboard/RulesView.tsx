import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import {
  createRule,
  deleteRule,
  getRules,
  getRuleSchema,
  draftRuleFromEvent,
  RuleSpecError,
  updateRule,
  type RuleCondition,
  type RuleField,
  type RuleLeaf,
  type RuleEventDraft,
  type RuleSchema,
  type RuleSpec,
  type RuleThreshold,
  type UserRule,
} from '../../lib/api';
import { agentLabel } from '../forest/AgentMark';
import { Dropdown } from '../forest/Dropdown';
import { fmt } from '../forest/format';
import { Icon } from '../forest/icons';
import { listItem, listParent } from '../forest/motion';
import { Seg, Sev, Switch } from '../forest/ui';
import { autoName, blankSentence, fromSpec, toSpec, type Sentence } from '../../lib/ruleSentence';
import { useRulePreview } from '../../lib/useRulePreview';
import { RulePreviewCard, RuleSentenceEditor } from './RuleSentenceEditor';

const PILLAR_ICON: Record<string, string> = { security: 'lock', cost: 'dollar', usability: 'bolt' };
const PREVIEW_DAYS = 30;
const PRE_RUN_HINT = 'Uses only details known before a tool runs, so this rule can switch to blocking once cot supports it.';

/** Starting points, so nobody faces a blank form. Each is a complete, valid spec. */
const TEMPLATES: { title: string; blurb: string; spec: RuleSpec }[] = [
  {
    title: 'Production database access',
    blurb: 'Shell commands that reach a production database.',
    spec: {
      name: 'Production database access',
      pillar: 'security',
      severity: 'warn',
      type: 'match',
      when: { all: [
        { field: 'category', op: 'eq', value: 'shell' },
        { field: 'target', op: 'regex', value: '(psql|mysql|mongosh?|redis-cli).*(prod|production)' },
      ] },
      subject: 'target',
      recommendation: 'Point agents at a replica or a read-only role instead of production.',
    },
  },
  {
    title: 'New dependencies',
    blurb: 'Package installs the agent ran on its own.',
    spec: {
      name: 'Agent installed a package',
      pillar: 'security',
      severity: 'info',
      type: 'match',
      when: { all: [
        { field: 'category', op: 'eq', value: 'shell' },
        { field: 'target', op: 'regex', value: '\\b(npm (i|install|add)|pnpm add|yarn add|pip3? install|uv add|cargo add|brew install|go get)\\b' },
      ] },
      subject: 'target',
      recommendation: 'Check each new dependency before it lands in the lockfile.',
    },
  },
  {
    title: 'Infrastructure edits',
    blurb: 'Changes to Terraform, Kubernetes or Docker files.',
    spec: {
      name: 'Agent edited infrastructure',
      pillar: 'security',
      severity: 'warn',
      type: 'match',
      when: { all: [
        { field: 'category', op: 'eq', value: 'file_edit' },
        { field: 'target', op: 'regex', value: '(\\.tf$|\\.tfvars$|/k8s/|/helm/|Dockerfile|docker-compose)' },
      ] },
      subject: 'target',
      recommendation: 'Review infrastructure changes by hand before they are applied.',
    },
  },
  {
    title: 'Flaky MCP server',
    blurb: 'An MCP server that keeps failing.',
    spec: {
      name: 'Flaky MCP server',
      pillar: 'usability',
      severity: 'warn',
      type: 'threshold',
      when: { all: [
        { field: 'category', op: 'eq', value: 'mcp' },
        { field: 'status', op: 'eq', value: 'error' },
      ] },
      threshold: { group_by: ['mcp_server'], aggregate: 'count', op: 'gte', value: 5 },
      recommendation: 'Check the server’s auth and config, or remove it if it isn’t used.',
    },
  },
  {
    title: 'Expensive session',
    blurb: 'A single session that spends past a budget.',
    spec: {
      name: 'Session over budget',
      pillar: 'cost',
      severity: 'warn',
      type: 'threshold',
      when: { all: [{ field: 'tokens', op: 'gt', value: 0 }] },
      threshold: { group_by: ['session'], aggregate: 'sum', field: 'cost_usd', op: 'gte', value: 5 },
      recommendation: 'Split long tasks into smaller sessions, or use a cheaper model for routine work.',
    },
  },
];

const THRESHOLD_OPS: { k: RuleThreshold['op']; l: string }[] = [
  { k: 'gte', l: '≥' },
  { k: 'gt', l: '>' },
  { k: 'lte', l: '≤' },
  { k: 'lt', l: '<' },
  { k: 'eq', l: '=' },
];

// --- spec helpers -------------------------------------------------------------------

type Flat = { mode: 'all' | 'any'; leaves: RuleLeaf[] };

const isLeaf = (c: RuleCondition): c is RuleLeaf => 'field' in c;

/** The one-level shape the form edits; null for nested specs (edited as JSON). */
function flatten(when: RuleCondition | undefined): Flat | null {
  if (!when || typeof when !== 'object') return null;
  if (isLeaf(when)) return { mode: 'all', leaves: [when] };
  if ('all' in when && when.all.every(isLeaf)) return { mode: 'all', leaves: when.all as RuleLeaf[] };
  if ('any' in when && when.any.every(isLeaf)) return { mode: 'any', leaves: when.any as RuleLeaf[] };
  return null;
}

const build = ({ mode, leaves }: Flat): RuleCondition => (mode === 'all' ? { all: leaves } : { any: leaves });

function describeLeaf(l: RuleLeaf, schema: RuleSchema): string {
  const f = schema.fields.find((x) => x.name === l.field);
  const o = schema.operators.find((x) => x.name === l.op);
  const v = Array.isArray(l.value) ? l.value.join(', ') : l.value;
  return [f?.label ?? l.field, o?.label ?? l.op, v === undefined ? '' : String(v)].filter(Boolean).join(' ');
}

function describe(spec: RuleSpec, schema: RuleSchema): string {
  const sentence = fromSpec(spec);
  if (sentence) return autoName({ ...sentence, nameTouched: false });
  const flat = flatten(spec.when);
  const when = flat
    ? flat.leaves.map((l) => describeLeaf(l, schema)).join(flat.mode === 'all' ? ' and ' : ' or ')
    : 'Custom conditions';
  if (spec.type !== 'threshold' || !spec.threshold) return when;
  const t = spec.threshold;
  const label = (n?: string) => schema.fields.find((f) => f.name === n)?.label.toLowerCase() ?? n;
  const agg = t.aggregate === 'count' ? 'count' : `${t.aggregate} of ${label(t.field)}`;
  const per = t.group_by.length ? ` per ${t.group_by.map(label).join(' + ')}` : '';
  return `${when} · ${agg}${per} ${THRESHOLD_OPS.find((o) => o.k === t.op)?.l} ${t.value}`;
}

function opsFor(field: RuleField | undefined, schema: RuleSchema) {
  if (!field) return [];
  return schema.operators.filter((o) => o.kinds.includes(field.kind) && (o.name !== 'outside_project' || field.name === 'target'));
}

function invalidateFindings(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['insights'] });
}

// --- page --------------------------------------------------------------------------

type Editing = {
  id: string | null;
  spec: RuleSpec;
  mode: 'simple' | 'advanced';
  /** The sentence to open the simple editor on (else read from `spec`). */
  sentence?: Sentence;
  draft?: RuleEventDraft;
};

/** Open a spec in the simple editor when a sentence can express it, else the advanced one. */
function openSpec(id: string | null, spec: RuleSpec): Editing {
  const sentence = fromSpec(spec);
  return sentence ? { id, spec, mode: 'simple', sentence } : { id, spec, mode: 'advanced' };
}

export function RulesView({ fromEvent }: { fromEvent?: number }) {
  const qc = useQueryClient();
  const [schema, setSchema] = useState<RuleSchema | null>(null);
  const [rules, setRules] = useState<UserRule[] | null>(null);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);

  const [draftError, setDraftError] = useState<string | null>(null);

  const load = () => getRules().then(setRules).catch(() => setError(true));
  useEffect(() => {
    getRuleSchema().then(setSchema).catch(() => setError(true));
    void load();
  }, []);

  // "Make a rule from this" lands here as #/rules?from=<event id>.
  useEffect(() => {
    if (fromEvent == null) return;
    window.history.replaceState(null, '', '#/rules');
    setDraftError(null);
    draftRuleFromEvent(fromEvent)
      .then((draft) => {
        const sentence = fromSpec(draft.spec);
        setEditing(sentence
          ? { id: null, spec: draft.spec, mode: 'simple', sentence: { ...sentence, nameTouched: false }, draft }
          : { id: null, spec: draft.spec, mode: 'advanced' });
      })
      .catch(() => setDraftError("Couldn't make a rule from that event. Rules can be made from commands, files, web requests and tool calls."));
  }, [fromEvent]);

  const saveSpec = async (id: string | null, spec: RuleSpec) => {
    if (id) await updateRule(id, { spec });
    else await createRule(spec);
    setEditing(null);
    invalidateFindings(qc);
    void load();
  };

  const toggle = async (r: UserRule) => {
    setRules((rs) => rs?.map((x) => (x.id === r.id ? { ...x, enabled: !r.enabled } : x)) ?? rs);
    try {
      await updateRule(r.id, { enabled: !r.enabled });
      invalidateFindings(qc);
    } finally {
      void load();
    }
  };
  const remove = async (r: UserRule) => {
    if (!window.confirm(`Delete “${r.spec.name}”? Its findings are removed too.`)) return;
    await deleteRule(r.id);
    invalidateFindings(qc);
    void load();
  };

  if (editing && schema && editing.mode === 'simple') {
    return (
      <RuleSentenceEditor
        key={`${editing.id}-${editing.draft?.event.id ?? ''}`}
        schema={schema}
        title={editing.id ? 'Edit rule' : editing.draft ? 'Rule from this event' : 'New rule'}
        initial={editing.sentence ?? fromSpec(editing.spec) ?? blankSentence()}
        draft={editing.draft}
        onCancel={() => setEditing(null)}
        onSave={(spec) => saveSpec(editing.id, spec)}
        onAdvanced={(spec) => setEditing({ id: editing.id, spec, mode: 'advanced' })}
      />
    );
  }

  if (editing && schema) {
    return (
      <RuleEditor
        key={editing.id ?? 'new'}
        onSimple={(spec) => setEditing(openSpec(editing.id, spec))}
        schema={schema}
        initial={editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          invalidateFindings(qc);
          void load();
        }}
      />
    );
  }

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div>
            <span className="label">Govern</span>
            <h1>Rules</h1>
            <p>Your own checks. They run next to the built-in ones, and what they catch shows up in Findings.</p>
          </div>
          <button type="button" className="vbtn vbtn-primary vbtn-sm" disabled={!schema} onClick={() => setEditing({ id: null, spec: toSpec(blankSentence()), mode: 'simple', sentence: blankSentence() })}>
            New rule
          </button>
        </div>

        {draftError && <div className="card" style={{ marginBottom: 16 }}><div className="card-b"><p className="rule-err">{draftError}</p></div></div>}

        {error && !rules ? (
          <div className="card empty">Collector offline. Rules are unavailable.</div>
        ) : (
          <>
            <section className="card" aria-labelledby="vf-myrules" style={{ overflow: 'hidden' }}>
              <div className="card-h">
                <span className="card-t" id="vf-myrules">Your rules</span>
                {rules && <span className="mono faint" style={{ fontSize: 11 }}>{rules.filter((r) => r.enabled).length} of {rules.length} on</span>}
              </div>
              {!rules || !schema ? (
                <div className="card-b"><span className="sk" style={{ height: 18, width: 220 }} /></div>
              ) : rules.length === 0 ? (
                <div className="card-b"><p className="dim" style={{ margin: 0 }}>No rules yet. Start from a template below, or write one from scratch.</p></div>
              ) : (
                <motion.ul variants={listParent} initial={false} animate="show" style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
                  {rules.map((r) => (
                    <motion.li key={r.id} variants={listItem} className="rule-row">
                      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
                        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 500, fontSize: 13 }}>{r.spec.name}</span>
                          <Sev s={r.spec.severity} />
                          <span className="vchip c-dim"><Icon name={PILLAR_ICON[r.spec.pillar]} size={11} />{r.spec.pillar}</span>
                          {r.enforceable && <span className="vchip c-dim" title={PRE_RUN_HINT}>pre-run</span>}
                          {!r.valid && <span className="vchip c-critical" title={r.error ?? ''}>needs fixing</span>}
                        </span>
                        <span className="mono faint truncate" style={{ fontSize: 11 }} title={describe(r.spec, schema)}>{describe(r.spec, schema)}</span>
                        <span className="faint" style={{ fontSize: 11 }}>Edited {fmt.ago(r.updated_at, new Date().toISOString())}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Switch on={r.enabled} onChange={() => void toggle(r)} label={`${r.enabled ? 'Turn off' : 'Turn on'} ${r.spec.name}`} />
                        <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={() => setEditing(openSpec(r.id, r.spec))}>Edit</button>
                        <button type="button" className="iconbtn" aria-label={`Delete ${r.spec.name}`} title="Delete" onClick={() => void remove(r)}><Icon name="trash" size={15} /></button>
                      </div>
                    </motion.li>
                  ))}
                </motion.ul>
              )}
            </section>

            <section aria-labelledby="vf-templates" style={{ marginTop: 24 }}>
              <span className="label" id="vf-templates">Start from a template</span>
              <div className="rule-templates">
                {TEMPLATES.map((t) => (
                  <button key={t.title} type="button" className="card hov rule-template" disabled={!schema} onClick={() => setEditing(openSpec(null, t.spec))}>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Icon name={PILLAR_ICON[t.spec.pillar]} size={14} />
                      <span style={{ fontWeight: 500, fontSize: 13 }}>{t.title}</span>
                    </span>
                    <span className="dim" style={{ fontSize: 12 }}>{t.blurb}</span>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// --- editor ------------------------------------------------------------------------

function RuleEditor({ schema, initial, onCancel, onSaved, onSimple }: {
  schema: RuleSchema;
  initial: Editing;
  onCancel: () => void;
  onSaved: () => void;
  onSimple: (spec: RuleSpec) => void;
}) {
  const [spec, setSpec] = useState<RuleSpec>(() => ({ scope: { sources: [], projects: [] }, ...structuredClone(initial.spec) }));
  const flat = flatten(spec.when);
  const [jsonMode, setJsonMode] = useState(flat === null);
  const [jsonText, setJsonText] = useState(() => JSON.stringify(initial.spec, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fieldBy = useMemo(() => new Map(schema.fields.map((f) => [f.name, f])), [schema]);
  const set = (patch: Partial<RuleSpec>) => setSpec((s) => ({ ...s, ...patch }));
  const setFlat = (next: Flat) => set({ when: build(next) });
  const setThreshold = (patch: Partial<RuleThreshold>) =>
    set({ threshold: { group_by: [], aggregate: 'count', op: 'gte', value: 5, ...spec.threshold, ...patch } });

  const { preview, problem, setProblem, loading } = useRulePreview(spec, PREVIEW_DAYS);

  const switchToJson = () => {
    setJsonText(JSON.stringify(spec, null, 2));
    setJsonError(null);
    setJsonMode(true);
  };
  const switchToForm = () => {
    if (!flatten(spec.when)) {
      setJsonError('These conditions are nested, so they can only be edited as JSON.');
      return;
    }
    setJsonMode(false);
  };
  const onJson = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text) as RuleSpec;
      setJsonError(null);
      setSpec(parsed);
    } catch (e) {
      setJsonError((e as Error).message);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      if (initial.id) await updateRule(initial.id, { spec });
      else await createRule(spec);
      onSaved();
    } catch (e) {
      if (e instanceof RuleSpecError) setProblem(e);
    } finally {
      setSaving(false);
    }
  };

  const errAt = (path: string) => (problem && (problem.path === path || problem.path.startsWith(`${path}.`) || problem.path.startsWith(`${path}[`)) ? problem.message : null);
  const sources = spec.scope?.sources ?? [];
  const groupable = schema.fields.filter((f) => f.groupable);

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div>
            <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={onCancel} style={{ marginLeft: -10, marginBottom: 6 }}><Icon name="back" size={14} />Rules</button>
            <h1>{initial.id ? 'Edit rule' : 'New rule'}</h1>
            <p>Describe the activity to watch for. The preview shows what it would have caught in the last {PREVIEW_DAYS} days.</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!jsonMode && fromSpec(spec) && <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => onSimple(spec)}>Simple editor</button>}
            <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={jsonMode ? switchToForm : switchToJson}>{jsonMode ? 'Edit as form' : 'Edit as JSON'}</button>
            <button type="button" className="vbtn vbtn-primary vbtn-sm" disabled={saving || !!jsonError || !spec.name?.trim()} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save rule'}
            </button>
          </div>
        </div>

        <div className="grid-2" style={{ marginTop: 0, gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)' }}>
          <section className="card">
            <div className="card-b rule-form">
              {jsonMode ? (
                <div className="rule-sec">
                  <label className="label" htmlFor="vf-rule-json">Rule as JSON</label>
                  <textarea id="vf-rule-json" className="input textarea mono" rows={24} value={jsonText} onChange={(e) => onJson(e.target.value)} spellCheck={false} />
                  {(jsonError || problem) && <p className="rule-err">{jsonError ?? `${problem!.path ? `${problem!.path}: ` : ''}${problem!.message}`}</p>}
                </div>
              ) : (
                <>
                  <div className="rule-sec">
                    <label className="label" htmlFor="vf-rule-name">Name</label>
                    <input id="vf-rule-name" className="input" style={{ width: '100%' }} value={spec.name} maxLength={120} placeholder="e.g. Agent touched production" onChange={(e) => set({ name: e.target.value })} />
                  </div>

                  <div className="rule-sec">
                    <span className="label">Fire</span>
                    <Seg
                      id="vf-rule-type"
                      label="Rule type"
                      value={spec.type}
                      onChange={(type) => set(type === 'threshold'
                        ? { type, threshold: spec.threshold ?? { group_by: ['session'], aggregate: 'count', op: 'gte', value: 5 } }
                        : { type, subject: spec.subject ?? 'target' })}
                      options={[{ k: 'match', l: 'Every match' }, { k: 'threshold', l: 'Over a limit' }]}
                    />
                  </div>

                  <div className="rule-sec">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span className="label">When an event matches</span>
                      <Seg id="vf-rule-mode" label="Combine conditions" value={flat!.mode} onChange={(mode) => setFlat({ ...flat!, mode })} options={[{ k: 'all', l: 'all of' }, { k: 'any', l: 'any of' }]} />
                    </span>
                    {flat!.leaves.map((leaf, i) => (
                      <ConditionRow
                        key={i}
                        leaf={leaf}
                        schema={schema}
                        fieldBy={fieldBy}
                        error={errAt(`when.${flat!.mode}[${i}]`)}
                        onChange={(next) => setFlat({ ...flat!, leaves: flat!.leaves.map((l, j) => (j === i ? next : l)) })}
                        onRemove={flat!.leaves.length > 1 ? () => setFlat({ ...flat!, leaves: flat!.leaves.filter((_, j) => j !== i) }) : undefined}
                      />
                    ))}
                    <button type="button" className="vbtn vbtn-ghost vbtn-sm" style={{ justifySelf: 'start' }} onClick={() => setFlat({ ...flat!, leaves: [...flat!.leaves, { field: 'target', op: 'contains', value: '' }] })}>
                      + Add condition
                    </button>
                  </div>

                  {spec.type === 'threshold' ? (
                    <div className="rule-sec">
                      <span className="label">Limit</span>
                      <div className="rule-line">
                        <Dropdown label="Measure" value={spec.threshold?.aggregate ?? 'count'} onChange={(v) => setThreshold({ aggregate: v as RuleThreshold['aggregate'], field: v === 'sum' ? 'cost_usd' : v === 'distinct' ? 'target' : undefined })}
                          options={[{ value: 'count', label: 'Number of events' }, { value: 'sum', label: 'Total of' }, { value: 'distinct', label: 'Distinct values of' }]} />
                        {spec.threshold?.aggregate !== 'count' && (
                          <Dropdown label="Field" value={spec.threshold?.field ?? ''} onChange={(v) => setThreshold({ field: v })}
                            options={schema.fields.filter((f) => spec.threshold?.aggregate === 'distinct' || f.kind === 'number').map((f) => ({ value: f.name, label: f.label }))} />
                        )}
                        <Dropdown label="Per" value={spec.threshold?.group_by[0] ?? ''} onChange={(v) => setThreshold({ group_by: v ? [v] : [] })}
                          options={[{ value: '', label: 'across everything' }, ...groupable.map((f) => ({ value: f.name, label: `per ${f.label.toLowerCase()}` }))]} />
                        <Dropdown label="Comparison" value={spec.threshold?.op ?? 'gte'} onChange={(v) => setThreshold({ op: v as RuleThreshold['op'] })} options={THRESHOLD_OPS.map((o) => ({ value: o.k, label: o.l }))} width={70} />
                        <input className="input mono" type="number" aria-label="Limit" style={{ width: 100 }} value={spec.threshold?.value ?? ''} onChange={(e) => setThreshold({ value: Number(e.target.value) })} />
                      </div>
                      {errAt('threshold') && <p className="rule-err">{errAt('threshold')}</p>}
                    </div>
                  ) : (
                    <div className="rule-sec">
                      <span className="label">One finding per</span>
                      <Dropdown label="One finding per" value={spec.subject ?? 'target'} onChange={(v) => set({ subject: v })}
                        options={[{ value: 'rule', label: 'rule (all matches together)' }, ...groupable.map((f) => ({ value: f.name, label: f.label.toLowerCase() }))]} />
                    </div>
                  )}

                  <div className="rule-sec">
                    <span className="label">Only for</span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {schema.sources.map((s) => {
                        const on = sources.includes(s);
                        return (
                          <button key={s} type="button" className="vbtn vbtn-quiet vbtn-sm" aria-pressed={on}
                            style={on ? { borderColor: 'var(--v-hot)', color: 'var(--v-hot)' } : undefined}
                            onClick={() => set({ scope: { projects: spec.scope?.projects ?? [], sources: on ? sources.filter((x) => x !== s) : [...sources, s] } })}>
                            {agentLabel(s)}
                          </button>
                        );
                      })}
                    </div>
                    <input className="input mono" style={{ width: '100%' }} placeholder="Project folders, comma separated (e.g. ~/work/*). Empty means all projects."
                      value={(spec.scope?.projects ?? []).join(', ')}
                      onChange={(e) => set({ scope: { sources, projects: e.target.value.split(',').map((p) => p.trim()).filter(Boolean) } })} />
                    <span className="faint" style={{ fontSize: 11 }}>No agent picked means every agent.</span>
                  </div>

                  <div className="rule-sec rule-line">
                    <div style={{ display: 'grid', gap: 6 }}>
                      <span className="label">Severity</span>
                      <Seg id="vf-rule-sev" value={spec.severity} onChange={(severity) => set({ severity })} options={schema.severities.map((s) => ({ k: s, l: s }))} />
                    </div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      <span className="label">Pillar</span>
                      <Seg id="vf-rule-pillar" value={spec.pillar} onChange={(pillar) => set({ pillar })} options={schema.pillars.map((p) => ({ k: p, l: p }))} />
                    </div>
                    {schema.actions.length > 1 && (
                      <div style={{ display: 'grid', gap: 6 }}>
                        <span className="label">On match</span>
                        <Seg id="vf-rule-action" value={spec.action ?? 'finding'} onChange={(action) => set({ action })} options={schema.actions.map((a) => ({ k: a, l: a === 'finding' ? 'record' : a }))} />
                      </div>
                    )}
                  </div>

                  <div className="rule-sec">
                    <label className="label" htmlFor="vf-rule-rec">What to do about it</label>
                    <textarea id="vf-rule-rec" className="input textarea" rows={3} maxLength={1000} placeholder="Shown with every finding, e.g. “Use the read replica.”"
                      value={spec.recommendation ?? ''} onChange={(e) => set({ recommendation: e.target.value })} />
                  </div>

                  {problem && !problem.path.startsWith('when') && !problem.path.startsWith('threshold') && (
                    <p className="rule-err">{problem.path ? `${problem.path}: ` : ''}{problem.message}</p>
                  )}
                </>
              )}
            </div>
          </section>

          <div style={{ alignSelf: 'start', position: 'sticky', top: 0 }}>
            <RulePreviewCard preview={preview} loading={loading} failed={!!problem} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ConditionRow({ leaf, schema, fieldBy, error, onChange, onRemove }: {
  leaf: RuleLeaf;
  schema: RuleSchema;
  fieldBy: Map<string, RuleField>;
  error: string | null;
  onChange: (l: RuleLeaf) => void;
  onRemove?: () => void;
}) {
  const field = fieldBy.get(leaf.field);
  const ops = opsFor(field, schema);
  const op = schema.operators.find((o) => o.name === leaf.op);
  const pickField = (name: string) => {
    const f = fieldBy.get(name);
    const first = opsFor(f, schema)[0];
    onChange({ field: name, op: first?.name ?? 'eq', value: first?.value === 'none' ? undefined : f?.kind === 'enum' ? f.options[0] : '' });
  };
  const pickOp = (name: string) => {
    const o = schema.operators.find((x) => x.name === name);
    const value = o?.value === 'none' ? undefined
      : o?.value === 'list' ? (Array.isArray(leaf.value) ? leaf.value : leaf.value ? [String(leaf.value)] : [])
      : Array.isArray(leaf.value) ? leaf.value[0] ?? '' : leaf.value ?? '';
    onChange({ field: leaf.field, op: name, value });
  };

  let input = null;
  if (op?.value === 'one' && field?.kind === 'enum') {
    input = <Dropdown label="Value" value={String(leaf.value ?? '')} onChange={(v) => onChange({ ...leaf, value: v })} options={field.options.map((o) => ({ value: o, label: o.replace(/_/g, ' ') }))} />;
  } else if (op?.value === 'one') {
    input = (
      <input className="input mono" aria-label="Value" style={{ flex: 1, minWidth: 140, width: 'auto' }}
        type={field?.kind === 'number' ? 'number' : 'text'}
        placeholder={op.name === 'regex' ? 'regular expression' : op.name === 'glob' ? '*.env* or ~/secrets/**' : 'value'}
        value={leaf.value === undefined ? '' : String(leaf.value)}
        onChange={(e) => onChange({ ...leaf, value: field?.kind === 'number' ? Number(e.target.value) : e.target.value })} />
    );
  } else if (op?.value === 'list') {
    const values = Array.isArray(leaf.value) ? leaf.value : [];
    input = field?.kind === 'enum' ? (
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1 }}>
        {field.options.map((o) => {
          const on = values.includes(o);
          return (
            <button key={o} type="button" className="vbtn vbtn-quiet vbtn-sm" aria-pressed={on} style={on ? { borderColor: 'var(--v-hot)', color: 'var(--v-hot)' } : undefined}
              onClick={() => onChange({ ...leaf, value: on ? values.filter((v) => v !== o) : [...values, o] })}>
              {o.replace(/_/g, ' ')}
            </button>
          );
        })}
      </div>
    ) : (
      <input className="input mono" aria-label="Values" style={{ flex: 1, minWidth: 140, width: 'auto' }} placeholder="comma, separated, values"
        value={values.join(', ')} onChange={(e) => onChange({ ...leaf, value: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })} />
    );
  }

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div className="rule-line">
        <Dropdown label="Field" value={leaf.field} onChange={pickField} searchable
          options={schema.fields.map((f) => ({ value: f.name, label: f.label, meta: f.phase === 'post' ? 'after run' : undefined }))} />
        <Dropdown label="Operator" value={leaf.op} onChange={pickOp} options={ops.map((o) => ({ value: o.name, label: o.label }))} />
        {input}
        {onRemove && <button type="button" className="iconbtn" aria-label="Remove condition" title="Remove" onClick={onRemove}><Icon name="close" size={14} /></button>}
      </div>
      {error && <p className="rule-err">{error}</p>}
    </div>
  );
}
