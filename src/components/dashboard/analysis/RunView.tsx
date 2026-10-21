import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  APPLIES, applyDeliverable, askFollowUp, cancelRun, deleteRun, deliverableText, exportUrl, getEstimate, getPersonas,
  getRun, setDeliverableStatus, startRun, type AnalysisRun, type Deliverable, type FollowUp,
} from '../../../lib/analysis';
import { Icon } from '../../forest/icons';
import { Sev } from '../../forest/ui';
import { CopyButton, EvidenceChips, Md, PERSONA_ICON, PERSONA_SHORT, StepList, usd, when } from './parts';

const KIND_ICON: Record<string, string> = {
  prompt_rewrite: 'prompt', memory_edit: 'edit', rule: 'filter', checklist: 'check', root_cause: 'trace',
  cost_table: 'dollar', config_change: 'sliders', risk_register: 'lock', summary: 'file', task_list: 'check',
};

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function RunView({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const key = ['analysis', 'run', runId];
  const { data: run, isError } = useQuery({
    queryKey: key,
    queryFn: () => getRun(runId),
    // Fast while the agent works (it streams steps), quiet once it is done.
    refetchInterval: (q) => {
      const r = q.state.data;
      return r && (r.status === 'running' || r.followups?.some((f) => f.status === 'running')) ? 1200 : false;
    },
  });
  const { data: catalog } = useQuery({ queryKey: ['analysis', 'personas'], queryFn: getPersonas, staleTime: Infinity });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: ['analysis', 'runs'] });
  };

  if (isError) {
    return (
      <div className="scroll"><div className="page">
        <div className="card empty">This analysis doesn't exist any more. <a href="#/analysis">Back to Analysis</a></div>
      </div></div>
    );
  }
  if (!run) {
    return (
      <div className="scroll"><div className="page an-page" aria-busy="true">
        <span className="sk" style={{ width: 120, height: 12 }} />
        <span className="sk" style={{ width: '60%', height: 30, marginTop: 12 }} />
        <span className="sk" style={{ width: '100%', height: 220, marginTop: 24 }} />
      </div></div>
    );
  }

  const persona = catalog?.personas.find((p) => p.key === run.persona);
  const subject = run.scope === 'across'
    ? <>All sessions · last {run.days ?? 30} days</>
    : <a href={`#/session/${encodeURIComponent(run.session_id ?? '')}`} className="mono">session {run.session_id?.slice(0, 8)}</a>;
  const by = run.runner === 'agent' ? `written by ${run.provider ?? 'your agent'}${run.model ? ` (${run.model})` : ''}` : run.model ?? run.provider;
  const cost = usd(run.usage?.cost_usd);

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page an-page">
        <a href="#/analysis" className="an-back"><Icon name="back" size={14} />Analysis</a>
        <header className="an-head">
          <div style={{ minWidth: 0 }}>
            <span className="label an-head-l"><Icon name={PERSONA_ICON[run.persona]} size={12} />{persona?.name ?? PERSONA_SHORT[run.persona]}</span>
            <h1>{run.report?.title ?? (run.status === 'running' ? 'Investigating…' : run.status === 'error' ? 'This run failed' : 'Cancelled')}</h1>
            <p className="dim">
              {subject} · {when(run.created_at)} · {by}{cost ? ` · ${cost}` : ''}
            </p>
            {run.question && <p className="an-asked">“{run.question}”</p>}
          </div>
          <div className="an-head-a">
            {run.status === 'running' && run.runner === 'cot' && (
              <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={() => void cancelRun(run.id).then(refresh)}>Stop</button>
            )}
            {run.status === 'ok' && (
              <a className="vbtn vbtn-quiet vbtn-sm" href={exportUrl(run.id)} download><Icon name="download" size={14} />Export .md</a>
            )}
            <DeleteButton runId={run.id} />
          </div>
        </header>

        {run.status === 'running' && (
          <div className="an-grid">
            <section className="card" aria-label="Investigation">
              <div className="card-h"><span className="card-t">Investigation</span><span className="faint mono" style={{ fontSize: 12 }}>{(run.steps ?? []).filter((s) => s.kind === 'tool').length} steps</span></div>
              <div className="card-b"><StepList steps={run.steps ?? []} live /></div>
            </section>
            <aside className="an-wait">
              {[0.9, 0.7, 0.8].map((w, i) => <span key={i} className="sk" style={{ height: 14, width: `${w * 100}%` }} />)}
              <p className="dim">The report appears here when the agent has read enough. Most runs take one to three minutes. You can leave this page; it keeps going.</p>
            </aside>
          </div>
        )}

        {(run.status === 'error' || run.status === 'cancelled') && <FailedRun run={run} />}

        {run.status === 'ok' && run.report && (
          <>
            <p className="an-summary">{run.report.summary}</p>
            <div className="an-grid">
              <div className="an-main">
                {(run.deliverables?.length ?? 0) > 0 && (
                  <section aria-label="Deliverables">
                    <div className="an-sec-h"><span className="label">Deliverables</span><span className="faint mono" style={{ fontSize: 11 }}>{run.deliverables!.length}</span></div>
                    <div className="an-dels">
                      {run.deliverables!.map((d) => <DeliverableCard key={d.id} run={run} d={d} onChange={refresh} />)}
                    </div>
                  </section>
                )}
                <section aria-label="Report" className="an-report">
                  <div className="an-sec-h"><span className="label">Report</span></div>
                  {run.report.sections.map((s) => (
                    <article key={s.heading} className="an-section">
                      <h2>{s.heading}</h2>
                      <Md text={s.body} />
                      <EvidenceChips evidence={s.evidence} />
                    </article>
                  ))}
                </section>
                <FollowUps run={run} onAsked={refresh} />
              </div>
              <aside className="an-side">
                <section className="card" aria-label="Findings">
                  <div className="card-h"><span className="card-t">Findings</span><span className="faint mono" style={{ fontSize: 12 }}>{run.report.findings.length}</span></div>
                  <div className="an-findings">
                    {run.report.findings.length === 0 && <div className="card-b dim" style={{ fontSize: 13 }}>Nothing worth flagging.</div>}
                    {run.report.findings.map((f, i) => (
                      <div key={i} className="an-finding">
                        <div className="an-finding-h"><Sev s={f.severity} /><span className="an-finding-t">{f.title}</span></div>
                        <p className="dim">{f.detail}</p>
                        <EvidenceChips evidence={f.evidence} />
                      </div>
                    ))}
                  </div>
                  {run.report.dropped_findings > 0 && (
                    <div className="an-dropped faint">{run.report.dropped_findings} finding{run.report.dropped_findings === 1 ? '' : 's'} left out: no step backed {run.report.dropped_findings === 1 ? 'it' : 'them'}.</div>
                  )}
                </section>
                {(run.steps?.length ?? 0) > 0 && (
                  <details className="card an-how">
                    <summary className="card-h"><span className="card-t">How it got here</span><span className="an-how-r"><span className="faint mono" style={{ fontSize: 12 }}>{run.steps!.filter((s) => s.kind === 'tool').length} steps</span><Icon name="chevron" size={14} className="an-how-chev" /></span></summary>
                    <div className="card-b"><StepList steps={run.steps!} /></div>
                  </details>
                )}
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DeleteButton({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const del = useMutation({
    mutationFn: () => deleteRun(runId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['analysis', 'runs'] });
      window.location.hash = '#/analysis';
    },
  });
  return confirm ? (
    <span className="an-confirm">
      <button type="button" className="vbtn vbtn-danger vbtn-sm" onClick={() => del.mutate()} disabled={del.isPending}>Delete run</button>
      <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => setConfirm(false)}>Keep</button>
    </span>
  ) : (
    <button type="button" className="iconbtn" aria-label="Delete this analysis" title="Delete" onClick={() => setConfirm(true)}><Icon name="trash" size={15} /></button>
  );
}

function FailedRun({ run }: { run: AnalysisRun }) {
  const again = useMutation({
    mutationFn: () => startRun({ scope: run.scope, session_id: run.session_id, persona: run.persona, question: run.question ?? undefined, days: run.days ?? 30 }),
    onSuccess: (r) => { window.location.hash = `#/analysis/${r.id}`; },
  });
  return (
    <div className="an-grid">
      <section className="card an-failed" aria-label="Error">
        <div className="card-b">
          <div className="card-t">{run.status === 'cancelled' ? 'You stopped this run.' : 'The analysis did not finish.'}</div>
          {run.error && run.status !== 'cancelled' && <p className="mono an-err-msg">{run.error}</p>}
          {run.runner === 'cot' && (
            <button type="button" className="vbtn vbtn-primary vbtn-sm" onClick={() => again.mutate()} disabled={again.isPending}>
              <Icon name="replay" size={14} />Run it again
            </button>
          )}
          {again.isError && <p className="an-err">{(again.error as Error).message}</p>}
        </div>
      </section>
      {(run.steps?.length ?? 0) > 0 && (
        <section className="card"><div className="card-h"><span className="card-t">Steps before it stopped</span></div><div className="card-b"><StepList steps={run.steps!} /></div></section>
      )}
    </div>
  );
}

function DeliverableCard({ run, d, onChange }: { run: AnalysisRun; d: Deliverable; onChange: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [cwd, setCwd] = useState('');
  const apply = useMutation({
    mutationFn: () => applyDeliverable(run.id, d.id, cwd.trim() || undefined),
    onSuccess: () => { setConfirm(false); onChange(); },
  });
  const status = useMutation({
    mutationFn: (s: Deliverable['status']) => setDeliverableStatus(run.id, d.id, s),
    onSuccess: onChange,
  });
  const verb = APPLIES[d.kind];
  const text = deliverableText(d);
  const fileName = `${d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || d.kind}.md`;

  return (
    <article className="card an-del" data-status={d.status}>
      <div className="an-del-h">
        <span className="an-del-ic"><Icon name={KIND_ICON[d.kind] ?? 'file'} size={14} /></span>
        <div style={{ minWidth: 0 }}>
          <span className="label">{labelFor(d)}</span>
          <div className="an-del-t">{d.title}</div>
        </div>
        {d.status === 'applied' && <span className="vchip c-ok"><Icon name="check" size={12} />{d.kind === 'rule' ? 'Rule created' : d.kind === 'memory_edit' ? 'Appended' : 'Done'}</span>}
        {d.status === 'dismissed' && <span className="vchip c-dim">Dismissed</span>}
      </div>

      <div className="an-del-b">
        {d.kind === 'prompt_rewrite' && (
          <div className="an-rewrite">
            {d.before && <div><span className="label">You wrote</span><blockquote>{d.before}</blockquote></div>}
            <div><span className="label">Try</span><blockquote className="an-after">{d.after}</blockquote></div>
          </div>
        )}
        {d.kind === 'memory_edit' && (
          <div>
            <span className="label">Append to {d.file}</span>
            <pre className="an-code">{d.append}</pre>
          </div>
        )}
        {d.kind === 'rule' && (
          <div>
            <p>{d.rule_text}</p>
            {!d.rule_spec && <p className="faint" style={{ fontSize: 12 }}>cot will turn this into a rule with your AI provider when you create it.</p>}
          </div>
        )}
        {d.kind === 'config_change' && d.savings_usd != null && (
          <span className="an-save mono">saves about {usd(d.savings_usd)} per similar session</span>
        )}
        {d.body && <Md text={d.body} />}
        <EvidenceChips evidence={d.evidence} max={4} />
      </div>

      {d.status === 'applied' && d.applied?.path && <div className="an-del-done faint mono truncate">{d.applied.unchanged ? 'Already in' : 'Added to'} {d.applied.path}</div>}
      {d.status === 'applied' && d.applied?.rule_id && <div className="an-del-done"><a href="#/rules">Open in Rules</a></div>}

      {confirm && verb ? (
        <div className="an-del-confirm">
          <span className="dim">
            {d.kind === 'memory_edit'
              ? <>Appends this text to {d.file} in {run.scope === 'session' ? 'the session’s project folder' : 'the folder below'}.</>
              : <>Creates an enabled rule that raises a finding when this happens again.</>}
          </span>
          {d.kind === 'memory_edit' && run.scope === 'across' && (
            <input className="an-input mono" placeholder="/path/to/project" value={cwd} onChange={(e) => setCwd(e.target.value)} aria-label="Project folder" />
          )}
          <span className="an-del-confirm-a">
            <button type="button" className="vbtn vbtn-primary vbtn-sm" onClick={() => apply.mutate()} disabled={apply.isPending}>{apply.isPending ? 'Working…' : verb}</button>
            <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => setConfirm(false)}>Cancel</button>
          </span>
          {apply.isError && <span className="an-err" role="alert">{(apply.error as Error).message}</span>}
        </div>
      ) : (
        <div className="an-del-a">
          {verb && d.status !== 'applied' && (
            <button type="button" className="vbtn vbtn-primary vbtn-sm" onClick={() => setConfirm(true)}>{verb}</button>
          )}
          <CopyButton text={text} />
          <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => download(fileName, `# ${d.title}\n\n${text}\n`)}><Icon name="download" size={14} />.md</button>
          <span style={{ flex: 1 }} />
          {d.status === 'new' && !verb && (
            <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => status.mutate('applied')}>Mark done</button>
          )}
          {d.status === 'new' ? (
            <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => status.mutate('dismissed')}>Dismiss</button>
          ) : d.status === 'dismissed' || !verb ? (
            <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => status.mutate('new')}>Undo</button>
          ) : null}
        </div>
      )}
    </article>
  );
}

const KIND_LABEL: Record<string, string> = {
  prompt_rewrite: 'Prompt rewrite', memory_edit: 'Project instructions', rule: 'cot rule', checklist: 'Checklist',
  root_cause: 'Root cause', cost_table: 'Cost breakdown', config_change: 'Config change', risk_register: 'Risk register',
  summary: 'Shareable summary', task_list: 'Follow-up tasks',
};
const labelFor = (d: Deliverable) => KIND_LABEL[d.kind] ?? d.kind;

function FollowUps({ run, onAsked }: { run: AnalysisRun; onAsked: () => void }) {
  const [q, setQ] = useState('');
  const { data: estimate } = useQuery({ queryKey: ['analysis', 'estimate', run.scope], queryFn: () => getEstimate(run.scope, null), staleTime: 60_000 });
  const ask = useMutation({ mutationFn: () => askFollowUp(run.id, q.trim()), onSuccess: () => { setQ(''); onAsked(); } });
  const items = run.followups ?? [];
  if (!estimate?.configured && items.length === 0) return null;
  return (
    <section className="an-fu" aria-label="Follow-up questions">
      <div className="an-sec-h"><span className="label">Follow-up</span></div>
      {items.map((f) => <FollowUpItem key={f.id} f={f} />)}
      {estimate?.configured && (
        <form className="an-fu-ask" onSubmit={(e) => { e.preventDefault(); if (q.trim()) ask.mutate(); }}>
          <input className="an-input" value={q} onChange={(e) => setQ(e.target.value)} maxLength={2000} placeholder="Ask about this report…" aria-label="Follow-up question" />
          <button type="submit" className="vbtn vbtn-quiet vbtn-sm" disabled={!q.trim() || ask.isPending}>Ask</button>
        </form>
      )}
      {ask.isError && <p className="an-err">{(ask.error as Error).message}</p>}
    </section>
  );
}

function FollowUpItem({ f }: { f: FollowUp }) {
  return (
    <div className="an-fu-i">
      <div className="an-fu-q">{f.question}</div>
      {f.status === 'running' && <StepList steps={f.steps} live />}
      {f.status === 'error' && <p className="an-err">{f.error}</p>}
      {f.status === 'ok' && (
        <div className="an-fu-a">
          <Md text={f.answer ?? ''} />
          {(f.points?.length ?? 0) > 0 && <ul>{f.points!.map((p, i) => <li key={i}>{p}</li>)}</ul>}
          <EvidenceChips evidence={f.evidence ?? []} />
        </div>
      )}
    </div>
  );
}
