import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { listRuns, runHref, type RunListItem } from '../../../lib/analysis';
import { Icon } from '../../forest/icons';
import { dayGroup, PERSONA_ICON, PERSONA_SHORT, RISE, usd, when } from './parts';

function subject(r: RunListItem): string {
  if (r.scope === 'across') return `All sessions · ${r.days ?? 30}d`;
  return `Session ${r.session_id?.slice(0, 8) ?? ''}`;
}

function byWho(r: RunListItem): string {
  return r.runner === 'agent' ? `by ${r.provider ?? 'your agent'}` : (r.model ?? r.provider ?? 'cot');
}

/** Saved runs, newest first, grouped by day. Running ones refresh on their own. */
export function Library({ sessionId, compact }: { sessionId?: string; compact?: boolean }) {
  const reduce = useReducedMotion();
  const { data: runs, isError } = useQuery({
    queryKey: ['analysis', 'runs', sessionId ?? 'all'],
    queryFn: () => listRuns({ sessionId }),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 3000 : 30_000),
  });

  if (isError) return <div className="card empty">The collector didn't answer, so saved analyses can't be listed.</div>;
  if (!runs) {
    return (
      <div className="card an-lib" aria-busy="true">
        {[0, 1, 2].map((i) => <div key={i} className="an-lib-row"><span className="sk" style={{ height: 36, width: '100%' }} /></div>)}
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="card an-lib-empty">
        <Icon name="sparkle" size={18} />
        <div>
          <div className="card-t">No analyses yet</div>
          <p className="dim">{sessionId ? 'Run one above. It lands here with its report and deliverables.' : 'Pick a session and a persona above. Every run is kept here with its report and deliverables, so you can come back to it or compare runs.'}</p>
        </div>
      </div>
    );
  }

  const groups: [string, RunListItem[]][] = [];
  for (const r of runs) {
    const g = dayGroup(r.created_at);
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(r);
    else groups.push([g, [r]]);
  }

  return (
    <div className="an-lib-wrap">
      {groups.map(([g, rows]) => (
        <section key={g} aria-label={g}>
          {!compact && <div className="label an-lib-g">{g}</div>}
          <div className="card an-lib">
            {rows.map((r, i) => (
              <motion.a
                key={r.id}
                href={runHref(r.id)}
                className="an-lib-row"
                initial={reduce ? false : { opacity: 0, transform: 'translateY(4px)' }}
                animate={{ opacity: 1, transform: 'translateY(0px)' }}
                transition={{ ...RISE, delay: Math.min(i, 8) * 0.03 }}
              >
                <span className="an-lib-ic" data-status={r.status}>
                  {r.status === 'running' ? <span className="an-live"><i /></span> : <Icon name={PERSONA_ICON[r.persona]} size={15} />}
                </span>
                <span className="an-lib-main">
                  <span className="an-lib-t truncate">
                    {r.status === 'running' ? 'Investigating…' : r.status === 'error' ? 'Run failed' : r.status === 'cancelled' ? 'Cancelled' : r.title ?? PERSONA_SHORT[r.persona]}
                  </span>
                  <span className="an-lib-m faint">
                    {PERSONA_SHORT[r.persona]}{!compact && <> · {subject(r)}</>} · {byWho(r)}
                  </span>
                </span>
                <span className="an-lib-n mono">
                  {r.status === 'ok' && (
                    <>
                      <span title="Findings">{r.findings} found</span>
                      <span title="Deliverables" data-done={r.applied > 0 && r.applied === r.deliverables}>
                        {r.applied > 0 ? `${r.applied}/${r.deliverables}` : r.deliverables} deliverable{r.deliverables === 1 ? '' : 's'}
                      </span>
                    </>
                  )}
                  {r.status === 'error' && <span className="an-err truncate" title={r.error ?? ''}>{r.error}</span>}
                </span>
                <span className="an-lib-w faint mono">{[usd(r.cost_usd), when(r.created_at)].filter(Boolean).join(' · ')}</span>
              </motion.a>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
