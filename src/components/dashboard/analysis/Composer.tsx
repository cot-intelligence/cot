import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { getSessionsPage, type SessionSummary } from '../../../lib/api';
import { getEstimate, getPersonas, runHref, startRun, type AnalysisScope, type Persona, type PersonaKey } from '../../../lib/analysis';
import { project as fproject } from '../../forest/format';
import { Icon } from '../../forest/icons';
import { Seg } from '../../forest/ui';
import { PERSONA_ICON, usd } from './parts';

const WINDOWS = [
  { k: 7, l: '7d' },
  { k: 30, l: '30d' },
  { k: 90, l: '90d' },
];

function sessionLabel(s: SessionSummary): string {
  const title = (s.title ?? 'Untitled session').replace(/\s+/g, ' ');
  return `${fproject(s.cwd)} · ${title.length > 70 ? `${title.slice(0, 69)}…` : title}`;
}

interface ComposerProps {
  /** On a session page: analyse this session only (no scope or session picker). */
  fixedSessionId?: string;
}

/**
 * Pick what to analyse, through whose eyes, and (optionally) what to ask. The
 * footer says what it will cost before anything is sent; a run is explicit and
 * opens on its own page while the agent investigates.
 */
export function Composer({ fixedSessionId }: ComposerProps) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<AnalysisScope>('session');
  const [days, setDays] = useState(30);
  const [picked, setPicked] = useState<string | null>(null);
  const [persona, setPersona] = useState<PersonaKey>('debugger');
  const [question, setQuestion] = useState('');

  const { data: catalog } = useQuery({ queryKey: ['analysis', 'personas'], queryFn: getPersonas, staleTime: Infinity });
  const { data: recent } = useQuery({
    queryKey: ['analysis', 'session-picker'],
    queryFn: async () => {
      const [marked, latest] = await Promise.all([
        getSessionsPage({ bookmarked: true, limit: 20 }),
        getSessionsPage({ limit: 40 }),
      ]);
      return { marked: marked.sessions, latest: latest.sessions.filter((s) => !s.bookmarked) };
    },
    enabled: !fixedSessionId,
    staleTime: 30_000,
  });

  const sessionId = fixedSessionId ?? picked ?? recent?.marked[0]?.id ?? recent?.latest[0]?.id ?? null;
  const effectiveScope: AnalysisScope = fixedSessionId ? 'session' : scope;
  const { data: estimate } = useQuery({
    queryKey: ['analysis', 'estimate', effectiveScope],
    queryFn: () => getEstimate(effectiveScope, null),
    staleTime: 60_000,
  });

  const chosen: Persona | undefined = catalog?.personas.find((p) => p.key === persona);
  const needsQuestion = persona === 'custom' && !question.trim();
  const run = useMutation({
    mutationFn: () => startRun({
      scope: effectiveScope,
      session_id: effectiveScope === 'session' ? sessionId : null,
      persona,
      question: question.trim() || undefined,
      days,
    }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['analysis', 'runs'] });
      window.location.hash = runHref(r.id);
    },
  });

  const agentPrompt = useMemo(() => {
    const who = chosen?.name.toLowerCase() ?? persona;
    const what = effectiveScope === 'session' && sessionId ? `session ${sessionId}` : `all my sessions from the last ${days} days`;
    return `Use cot's analysis_brief to run the ${who} analysis (persona "${persona}") on ${what}${question.trim() ? `, focused on: ${question.trim()}` : ''}. Investigate with cot's investigate tool, then save it with save_analysis.`;
  }, [chosen, persona, effectiveScope, sessionId, days, question]);

  const blocked = !estimate?.configured;
  const canRun = !blocked && !needsQuestion && (effectiveScope === 'across' || !!sessionId) && !run.isPending;
  const typical = usd(estimate?.typical_usd);

  return (
    <section className="card an-composer" aria-label="New analysis">
      <div className="card-b an-composer-b">
        {!fixedSessionId && (
          <div className="an-row">
            <span className="label">Analyse</span>
            <div className="an-row-c">
              <Seg id="an-scope" value={scope} onChange={setScope} label="What to analyse"
                options={[{ k: 'session', l: 'One session' }, { k: 'across', l: 'Across sessions' }]} />
              {scope === 'session' ? (
                <label className="an-select">
                  <select value={sessionId ?? ''} onChange={(e) => setPicked(e.target.value)} aria-label="Session">
                    {!recent && <option>Loading sessions…</option>}
                    {recent && recent.marked.length > 0 && (
                      <optgroup label="Bookmarked">
                        {recent.marked.map((s) => <option key={s.id} value={s.id}>{sessionLabel(s)}</option>)}
                      </optgroup>
                    )}
                    {recent && (
                      <optgroup label="Recent">
                        {recent.latest.map((s) => <option key={s.id} value={s.id}>{sessionLabel(s)}</option>)}
                      </optgroup>
                    )}
                  </select>
                  <Icon name="down" size={14} />
                </label>
              ) : (
                <Seg id="an-days" value={days} onChange={setDays} options={WINDOWS} label="Window" />
              )}
            </div>
          </div>
        )}

        <div className="an-row an-row-top">
          <span className="label">Through the eyes of</span>
          <div className="an-personas" role="radiogroup" aria-label="Persona">
            {!catalog && [0, 1, 2, 3, 4, 5].map((i) => <span key={i} className="sk" style={{ height: 64 }} />)}
            {catalog?.personas.map((p) => (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={persona === p.key}
                className="an-persona"
                onClick={() => setPersona(p.key)}
              >
                <span className="an-persona-ic"><Icon name={PERSONA_ICON[p.key]} size={15} /></span>
                <span className="an-persona-t">{p.name}</span>
                <span className="an-persona-d">{p.blurb}</span>
              </button>
            ))}
          </div>
        </div>

        {chosen && (
          <div className="an-row">
            <span className="label">You get</span>
            <div className="an-gets">
              <span className="an-get"><Icon name="file" size={13} />Report: {(effectiveScope === 'across' ? chosen.across_outline : chosen.outline).join(' · ')}</span>
              {chosen.deliverables.map((d) => (
                <span key={d.kind} className="an-get"><Icon name="check" size={13} />{d.label}</span>
              ))}
            </div>
          </div>
        )}

        <div className="an-row an-row-top">
          <label className="label" htmlFor="an-q">{persona === 'custom' ? 'Your question' : 'Focus (optional)'}</label>
          <textarea
            id="an-q"
            className="an-q"
            rows={2}
            maxLength={2000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={chosen?.starters[0] ?? 'What do you want to know about this session?'}
          />
        </div>
      </div>

      <div className="an-foot">
        <div className="an-foot-t">
          {estimate == null ? (
            <span className="sk" style={{ width: 220, height: 14 }} />
          ) : blocked ? (
            <span className="dim">
              {estimate.disabled ? 'AI is turned off on this machine (COT_DISABLE_LLM).' : <>No AI key yet. Add one in <a href="#/settings">Settings</a>, or run it from your own agent below.</>}
            </span>
          ) : (
            <span className="dim">
              <span className="mono">{estimate.model}</span>
              {typical && <> · usually about {typical}</>}
              {' · '}stops at {usd(estimate.cap_usd)}
            </span>
          )}
          {run.isError && <span className="an-err" role="alert">{(run.error as Error).message}</span>}
        </div>
        <button type="button" className="vbtn vbtn-primary" disabled={!canRun} onClick={() => run.mutate()}>
          {run.isPending ? 'Starting…' : 'Run analysis'}
          <Icon name="arrow" size={15} />
        </button>
      </div>

      <AgentPanel prompt={agentPrompt} />
    </section>
  );
}

/** The same analysis without an API key: the person's own agent runs it over cot mcp. */
function AgentPanel({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1400);
    });
  };
  const setup = 'claude mcp add cot -- ~/.cot/bin/cot mcp';
  return (
    <div className="an-agent" data-open={open}>
      <button type="button" className="an-agent-h" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="plug" size={14} />
        <span>Or run it from your own agent over cot mcp, with no API key</span>
        <Icon name="chevron" size={14} className="an-agent-chev" />
      </button>
      {open && (
        <div className="an-agent-b">
          <p className="dim">Your agent reads the session through cot, writes the report, and saves it here with its deliverables. It uses your agent's subscription, not a cot key.</p>
          <div className="an-cmd">
            <span className="label">1 · Connect once</span>
            <span className="dim" style={{ fontSize: 12 }}>
              <a href="#/settings" onClick={() => window.setTimeout(() => document.getElementById('set-mcp')?.scrollIntoView(), 50)}>Install cot MCP in Settings</a> (one click), or run <code className="mono">{setup}</code>
            </span>
            <button type="button" className="iconbtn" aria-label="Copy command" onClick={() => copy('setup', setup)}>
              <Icon name={copied === 'setup' ? 'check' : 'copy'} size={14} />
            </button>
          </div>
          <div className="an-cmd">
            <span className="label">2 · Ask your agent</span>
            <code className="mono">{prompt}</code>
            <button type="button" className="iconbtn" aria-label="Copy prompt" onClick={() => copy('prompt', prompt)}>
              <Icon name={copied === 'prompt' ? 'check' : 'copy'} size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
