import { useEffect, useState } from 'react';
import {
  draftRuleFromText,
  getSettings,
  RuleSpecError,
  type RuleEventDraft,
  type RuleLeaf,
  type RulePreview,
  type RuleSchema,
  type RuleSpec,
} from '../../lib/api';
import {
  autoName,
  fromSpec,
  isSpecific,
  opsFor,
  PER,
  toSpec,
  verbOf,
  VERBS,
  type Sentence,
  type VerbKey,
} from '../../lib/ruleSentence';
import { sessionHref } from '../../lib/sessionStore';
import { useRulePreview } from '../../lib/useRulePreview';
import { agentLabel } from '../forest/AgentMark';
import { Dropdown } from '../forest/Dropdown';
import { fmt } from '../forest/format';
import { Icon } from '../forest/icons';
import { Seg } from '../forest/ui';

const PREVIEW_DAYS = 30;
const PRE_RUN_HINT = 'Uses only details known before a tool runs, so this rule can switch to blocking once cot supports it.';

/** The friendly editor: a rule written as one sentence, with real examples underneath. */
export function RuleSentenceEditor({ schema, title, initial, draft, onCancel, onSave, onAdvanced }: {
  schema: RuleSchema;
  title: string;
  initial: Sentence;
  /** Set when started from an event: the generalizations to choose between. */
  draft?: RuleEventDraft;
  onCancel: () => void;
  onSave: (spec: RuleSpec) => Promise<void>;
  onAdvanced: (spec: RuleSpec) => void;
}) {
  const [s, setS] = useState<Sentence>(initial);
  const [picked, setPicked] = useState(draft?.picked ?? -1);
  const [details, setDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const spec = toSpec(s);
  const specific = isSpecific(s);
  const [needsDetail, setNeedsDetail] = useState(false);
  const { preview, problem, setProblem, loading } = useRulePreview(specific ? spec : null, PREVIEW_DAYS);
  const v = verbOf(s.verb);
  const set = (patch: Partial<Sentence>) => {
    setNeedsDetail(false);
    setS((cur) => ({ ...cur, ...patch }));
  };
  const setCond = (i: number, c: RuleLeaf) => set({ conds: s.conds.map((x, j) => (j === i ? c : x)) });

  const pickVerb = (verb: VerbKey) => {
    const next = verbOf(verb);
    const keep = s.conds.filter((c) => next.about.some((a) => a.field === c.field) && opsFor(verb, c.field).some((o) => o.op === c.op));
    set({
      verb,
      conds: keep.length || !next.about.length ? keep : [{ field: next.about[0].field, op: 'contains', value: '' }],
      subject: undefined,
      limit: verb === 'spend' ? null : s.limit,
    });
  };
  const pickChoice = (i: number) => {
    if (!draft) return;
    setPicked(i);
    set({ conds: draft.choices[i].conditions });
  };

  const save = async () => {
    if (!specific) {
      setNeedsDetail(true);
      return;
    }
    setSaving(true);
    try {
      await onSave(spec);
    } catch (e) {
      if (e instanceof RuleSpecError) setProblem(e);
    } finally {
      setSaving(false);
    }
  };

  const agents = [{ value: '', label: 'any agent' }, ...schema.sources.map((a) => ({ value: a, label: agentLabel(a) }))];
  const perOptions = Object.entries(PER)
    .filter(([k]) => k !== 'mcp_server' || s.verb === 'mcp')
    .filter(([k]) => k !== 'tool' || s.verb === 'mcp' || s.verb === 'any')
    .filter(([k]) => k !== 'program' || s.verb === 'shell')
    .map(([value, label]) => ({ value, label }));

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div>
            <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={onCancel} style={{ marginLeft: -10, marginBottom: 6 }}><Icon name="back" size={14} />Rules</button>
            <h1>{title}</h1>
            <p>Say what to watch for. Once you do, you'll see what it would have caught in the last {PREVIEW_DAYS} days.</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => onAdvanced(spec)}>Advanced editor</button>
            <button type="button" className="vbtn vbtn-primary vbtn-sm" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save rule'}</button>
          </div>
        </div>

        {!draft && <DescribeBox onDraft={(next) => {
          const sentence = fromSpec(next);
          if (sentence) setS(sentence);
          else onAdvanced(next);
        }} />}

        {draft && (
          <section className="card" style={{ marginBottom: 16 }}>
            <div className="card-b" style={{ display: 'grid', gap: 10 }}>
              <span className="label">Based on this {draft.event.category === 'shell' ? 'command' : 'event'}</span>
              <a className="mono dim truncate" style={{ fontSize: 12 }} href={`${sessionHref(draft.event.session_id)}?e=${draft.event.id}`} title={draft.event.target ?? ''}>
                {draft.event.target ?? draft.event.tool}
              </a>
              <span className="dim" style={{ fontSize: 13 }}>Match</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {draft.choices.map((c, i) => (
                  <button key={c.label} type="button" className="vbtn vbtn-quiet vbtn-sm" aria-pressed={picked === i}
                    style={picked === i ? { borderColor: 'var(--v-hot)', color: 'var(--v-hot)' } : undefined} onClick={() => pickChoice(i)}>
                    <BackticksAsMono text={c.label} />
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="card">
          <div className="card-b rule-sentence">
            <div className="rule-sline">
              <span>Tell me when</span>
              <Dropdown label="Agent" value={s.agent} onChange={(agent) => set({ agent })} options={agents} />
              <Dropdown label="Activity" value={s.verb} onChange={(k) => pickVerb(k as VerbKey)} options={VERBS.map((x) => ({ value: x.key, label: x.label }))} />
              {s.verb === 'spend' && (
                <>
                  <span className="input-wrap"><span className="dim" style={{ position: 'absolute', left: 10, fontSize: 13 }}>$</span>
                    <input className="input mono" type="number" min={0} step="0.5" aria-label="Budget in dollars" style={{ width: 90, paddingLeft: 20 }}
                      value={s.budget.amount} onChange={(e) => set({ budget: { ...s.budget, amount: Number(e.target.value) } })} /></span>
                  <Dropdown label="Per" value={s.budget.per} onChange={(per) => set({ budget: { ...s.budget, per } })}
                    options={[{ value: 'session', label: 'in one session' }, { value: 'project', label: 'on one project' }, { value: 'source', label: 'with one agent' }, { value: '', label: 'in total' }]} />
                </>
              )}
            </div>

            {s.conds.map((c, i) => {
              const ops = opsFor(s.verb, c.field);
              const op = ops.find((o) => o.op === c.op);
              return (
                <div key={i} className="rule-sline">
                  {i === 0 ? <span>where</span> : (
                    <button type="button" className="rule-join" onClick={() => set({ join: s.join === 'and' ? 'or' : 'and' })} title="Switch between and / or">{s.join}</button>
                  )}
                  {v.about.length > 1 ? (
                    <Dropdown label="About" value={c.field} onChange={(field) => setCond(i, { field, op: 'contains', value: '' })} options={v.about.map((a) => ({ value: a.field, label: a.label }))} />
                  ) : <span>{v.about[0]?.label}</span>}
                  <Dropdown label="Match" value={c.op} onChange={(o) => setCond(i, { ...c, op: o, value: ops.find((x) => x.op === o)?.none ? undefined : c.value ?? '' })} options={ops.map((o) => ({ value: o.op, label: o.label }))} />
                  {!op?.none && (
                    <input className="input mono" aria-label="Value" style={{ flex: '1 1 200px', width: 'auto', minWidth: 160 }}
                      placeholder={c.op === 'glob' ? '*.env* or ~/secrets/*' : c.op === 'regex' ? 'regular expression' : s.verb === 'shell' ? (c.field === 'program' ? 'git' : 'npm install') : s.verb === 'web' ? 'github.com' : s.verb === 'mcp' ? 'github' : '.env'}
                      value={c.value === undefined ? '' : String(c.value)} onChange={(e) => setCond(i, { ...c, value: e.target.value })} />
                  )}
                  {s.conds.length > 1 && <button type="button" className="iconbtn" aria-label="Remove condition" title="Remove" onClick={() => set({ conds: s.conds.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>}
                </div>
              );
            })}

            {s.verb !== 'spend' && (
              <div className="rule-adds">
                {v.about.length > 0 && <button type="button" className="rule-add" onClick={() => set({ conds: [...s.conds, { field: v.about[0].field, op: 'contains', value: '' }] })}>+ another condition</button>}
                <button type="button" className="rule-add" aria-pressed={s.fails} onClick={() => set({ fails: !s.fails })}>{s.fails ? '✓ ' : '+ '}and it fails</button>
                {!s.projects.length && !details && <button type="button" className="rule-add" onClick={() => setDetails(true)}>+ only in some projects</button>}
                {s.limit ? (
                  <span className="rule-sline" style={{ gap: 6 }}>
                    <span>at least</span>
                    <input className="input mono" type="number" min={1} aria-label="Times" style={{ width: 70 }} value={s.limit.count}
                      onChange={(e) => set({ limit: { ...s.limit!, count: Math.max(1, Number(e.target.value) || 1) } })} />
                    <span>times</span>
                    <Dropdown label="Per" value={s.limit.per} onChange={(per) => set({ limit: { ...s.limit!, per } })} options={perOptions} />
                    <button type="button" className="iconbtn" aria-label="Remove limit" onClick={() => set({ limit: null })}><Icon name="close" size={14} /></button>
                  </span>
                ) : (
                  <button type="button" className="rule-add" onClick={() => set({ limit: { count: 3, per: 'session' } })}>+ only if it happens repeatedly</button>
                )}
              </div>
            )}

            {s.verb === 'spend' && !s.projects.length && !details && (
              <div className="rule-adds"><button type="button" className="rule-add" onClick={() => setDetails(true)}>+ only in some projects</button></div>
            )}

            {needsDetail && <p className="rule-err">Say what to look for first, for example what the {v.noun} contains. Without it, this rule would flag every {v.noun}.</p>}
            {problem && <p className="rule-err">{problem.message}</p>}
          </div>

          <div className="rule-details">
            <button type="button" className="rule-add" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
              <Icon name={details ? 'down' : 'chevron'} size={12} /> {details ? 'Hide details' : `Named “${spec.name}” · ${s.severity} · ${spec.pillar}`}
            </button>
            {details && (
              <div className="rule-form" style={{ marginTop: 14 }}>
                <div className="rule-sec">
                  <label className="label" htmlFor="vf-rs-name">Name</label>
                  <input id="vf-rs-name" className="input" style={{ width: '100%' }} maxLength={120} placeholder={autoName(s)}
                    value={s.nameTouched ? s.name : ''} onChange={(e) => set({ name: e.target.value, nameTouched: e.target.value.trim() !== '' })} />
                </div>
                <div className="rule-sec">
                  <label className="label" htmlFor="vf-rs-proj">Only in projects</label>
                  <input id="vf-rs-proj" className="input mono" style={{ width: '100%' }} placeholder="~/work/*, ~/clients/acme. Empty means every project."
                    value={s.projects.join(', ')} onChange={(e) => set({ projects: e.target.value.split(',').map((p) => p.trim()).filter(Boolean) })} />
                </div>
                <div className="rule-sec rule-line">
                  <div style={{ display: 'grid', gap: 6 }}>
                    <span className="label">Severity</span>
                    <Seg id="vf-rs-sev" value={s.severity} onChange={(severity) => set({ severity })} options={schema.severities.map((x) => ({ k: x, l: x }))} />
                  </div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    <span className="label">Pillar</span>
                    <Seg id="vf-rs-pillar" value={spec.pillar} onChange={(pillar) => set({ pillar, pillarTouched: true })} options={schema.pillars.map((x) => ({ k: x, l: x }))} />
                  </div>
                </div>
                <div className="rule-sec">
                  <label className="label" htmlFor="vf-rs-rec">What to do about it</label>
                  <textarea id="vf-rs-rec" className="input textarea" rows={2} maxLength={1000} placeholder="Shown with every finding. Optional."
                    value={s.recommendation} onChange={(e) => set({ recommendation: e.target.value })} />
                </div>
              </div>
            )}
          </div>
        </section>

        {specific && <RulePreviewCard preview={preview} loading={loading} failed={!!problem} noun={v.noun} />}
      </div>
    </div>
  );
}

/** "Plain English → rule" through the user's AI provider. Explicit; it costs money. */
function DescribeBox({ onDraft }: { onDraft: (spec: RuleSpec) => void }) {
  const [ai, setAi] = useState<boolean | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getSettings().then((st) => setAi(Boolean(st.ai_configured) && !st.ai_env_disabled)).catch(() => setAi(false));
  }, []);

  const go = async () => {
    if (!text.trim()) {
      setError('Describe what you want to catch first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDraft(await draftRuleFromText(text));
    } catch (e) {
      setError(e instanceof RuleSpecError ? e.message : 'The AI request failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // Show the input while settings load (no layout jump); a missing key still
  // surfaces as a clear error from the draft request itself.
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-b" style={{ display: 'grid', gap: 8 }}>
        <label className="label" htmlFor="vf-rule-describe">Describe it</label>
        {ai !== false ? (
          <>
            <div className="rule-line">
              <input id="vf-rule-describe" className="input" style={{ flex: 1, width: 'auto', minWidth: 220 }} value={text} maxLength={1000}
                placeholder="Tell me when an agent reads a .env file outside the project"
                onChange={(e) => { setText(e.target.value); setError(null); }} onKeyDown={(e) => e.key === 'Enter' && void go()} />
              <button type="button" className="vbtn vbtn-quiet vbtn-sm" disabled={busy} onClick={() => void go()}>
                <Icon name="sparkle" size={14} />{busy ? 'Drafting…' : 'Draft rule'}
              </button>
            </div>
            {error ? <p className="rule-err">{error}</p> : <span className="faint" style={{ fontSize: 11 }}>Sends only your sentence to your AI provider, never your traces. You review the rule before it's saved.</span>}
          </>
        ) : (
          <span className="dim" style={{ fontSize: 13 }}>Add an AI key in <a href="#/settings/ai">Settings</a> to write rules in plain English. Or fill in the sentence below.</span>
        )}
      </div>
    </section>
  );
}

function BackticksAsMono({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 ? <code key={i} className="mono" style={{ fontSize: 12 }}>{part}</code> : <span key={i}>{part}</span>))}</>;
}

/** What the rule would have caught: counts, then the most frequent real examples. */
export function RulePreviewCard({ preview, loading, failed, noun = 'event', flush = false }: { preview: RulePreview | null; loading: boolean; failed: boolean; noun?: string; flush?: boolean }) {
  // Stacked under the sentence builder it needs a gap; beside the form
  // (`flush`) its top lines up with the form card's.
  return (
    <section className="card" style={flush ? undefined : { marginTop: 16 }} aria-live="polite" aria-busy={loading}>
      <div className="card-h">
        <span className="card-t">Would have caught</span>
        <span className="mono faint" style={{ fontSize: 11 }}>{loading ? 'checking…' : `last ${PREVIEW_DAYS} days`}</span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        {failed ? (
          <p className="dim" style={{ margin: 0 }}>Fix the rule above to see what it catches.</p>
        ) : !preview ? (
          <span className="sk" style={{ height: 18, width: 200 }} />
        ) : preview.events_matched === 0 ? (
          <p className="dim" style={{ margin: 0 }}>Nothing in the last {PREVIEW_DAYS} days. It will still catch new matches from now on.</p>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              <b className="tnum">{fmt.n(preview.events_matched)}</b> time{preview.events_matched === 1 ? '' : 's'} in{' '}
              <b className="tnum">{fmt.n(preview.sessions_matched)}</b> session{preview.sessions_matched === 1 ? '' : 's'}
              {preview.findings.length ? `, as ${preview.findings.length} finding${preview.findings.length === 1 ? '' : 's'}.` : ', but not enough for a finding yet.'}
            </p>
            {preview.events_scanned > 0 && preview.events_matched / preview.events_scanned > 0.2 && (
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>That's a large share of everything your agents do. Narrow it so findings stay worth reading.</p>
            )}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: '1px solid var(--v-line)', borderRadius: 10, overflow: 'hidden' }}>
              {preview.examples.map((ex, i) => (
                <li key={ex.label} style={{ borderTop: i ? '1px solid var(--v-line)' : undefined }}>
                  <a href={`${sessionHref(ex.session_id)}?e=${ex.event_id}`} className="hov rule-example" title={ex.label}>
                    <span className="mono truncate" style={{ fontSize: 12 }}>{ex.label}</span>
                    <span className="mono faint tnum" style={{ fontSize: 11 }}>{ex.count}×</span>
                  </a>
                </li>
              ))}
            </ul>
            {preview.distinct_examples > preview.examples.length && (
              <span className="faint" style={{ fontSize: 11 }}>and {fmt.n(preview.distinct_examples - preview.examples.length)} other {noun}{preview.distinct_examples - preview.examples.length === 1 ? '' : 's'}</span>
            )}
            <p className="faint" style={{ margin: 0, fontSize: 11, display: 'flex', gap: 6, alignItems: 'center' }}>
              {preview.enforceable ? <><Icon name="check" size={12} />{PRE_RUN_HINT}</> : 'Uses details only known after a tool runs, so it stays a detection rule.'}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
