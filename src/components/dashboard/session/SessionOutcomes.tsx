import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getSessionOutcomes, getSessionRecovery, getShipped } from '../../../lib/api';
import { ShippedRow } from '../ShippedView';
import { fmt } from '../../forest/format';
import { Icon } from '../../forest/icons';

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** What one session shipped and how it handled failed tool calls, as a row of chips. */
export function SessionOutcomes({ sessionId, onSelect }: { sessionId: string; onSelect: (sessionId: string, eventId?: number) => void }) {
  const [open, setOpen] = useState(false);
  const { data: list } = useQuery({ queryKey: ['shipped', 0, sessionId], queryFn: () => getShipped(0, { sessionId }), enabled: open, staleTime: 60_000 });
  const { data: out } = useQuery({ queryKey: ['session-outcomes', sessionId], queryFn: () => getSessionOutcomes(sessionId), staleTime: 60_000 });
  const { data: rec } = useQuery({ queryKey: ['session-recovery', sessionId], queryFn: () => getSessionRecovery(sessionId), staleTime: 30_000 });
  const commits = out ? Math.max(out.commits, out.git_commits) : 0;
  const shipped = out && (commits || out.pushes || out.prs_opened);
  const stuck = rec?.chains.find((c) => c.outcome !== 'recovered') ?? rec?.chains[0];
  const unfixed = rec ? rec.failures - rec.recovered : 0;
  if (!shipped && !rec?.failures) return null;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
      {shipped ? (
        <>
          <button type="button" className="vchip c-dim" aria-expanded={open} onClick={() => setOpen((x) => !x)} style={{ cursor: 'pointer', border: 0 }} title="List every PR, commit and push with links">
            Shipped<Icon name="down" size={11} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 160ms ease' }} />
          </button>
          {commits > 0 && <span className="vchip c-ok"><Icon name="branch" size={11} />{plural(commits, 'commit')}</span>}
          {out.pushes > 0 && <span className="vchip c-dim">{plural(out.pushes, 'push', 'pushes')}</span>}
          {out.prs_opened > 0 && <span className="vchip c-info">{plural(out.prs_opened, 'PR')}{out.prs_merged ? ` · ${out.prs_merged} merged` : ''}</span>}
          {out.git_commits > 0 && (
            <span className="vchip c-dim num-t" title={`${out.files} files changed in git`} style={{ textTransform: 'none', letterSpacing: 0 }}>
              <span className="d-add">+{fmt.k(out.added)}</span><span className="d-rm">−{fmt.k(out.removed)}</span>
            </span>
          )}
        </>
      ) : null}
      {rec && rec.failures > 0 && (
        <a
          href={stuck ? `#/session/${encodeURIComponent(sessionId)}?e=${stuck.event_id}` : undefined}
          className={`vchip ${unfixed ? 'c-warn' : 'c-dim'}`}
          style={{ marginLeft: shipped ? 6 : 0, textDecoration: 'none' }}
          title={`${rec.recovered} fixed${rec.avg_steps ? ` in ${rec.avg_steps} calls on average` : ''}, ${rec.moved_on} worked around, ${rec.abandoned} never recovered. Opens the ${unfixed ? 'first unfixed' : 'first'} failure.`}
        >
          {plural(rec.failures, 'tool failure')} · {unfixed ? `${unfixed} not fixed` : 'all fixed'}
        </a>
      )}
      {open && (
        <div style={{ flexBasis: '100%', marginTop: 4, border: '1px solid var(--v-line)', borderRadius: 12, background: 'var(--v-surface)' }}>
          {!list ? (
            <div style={{ padding: 12, display: 'grid', gap: 8 }}>{[0, 1].map((i) => <span key={i} className="sk" style={{ height: 36 }} />)}</div>
          ) : (
            <ul className="sh-list" style={{ paddingTop: 4 }}>
              {list.items.map((it, i) => <ShippedRow key={`${it.kind}:${it.event_id ?? it.sha}:${i}`} it={it} now={new Date().toISOString()} onSelect={onSelect} showProject={false} index={i} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
