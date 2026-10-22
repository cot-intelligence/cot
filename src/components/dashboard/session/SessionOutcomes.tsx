import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { getSessionOutcomes, getSessionRecovery, getShipped } from '../../../lib/api';
import { ShippedRow } from '../ShippedView';
import { fmt } from '../../forest/format';
import { Icon } from '../../forest/icons';

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** What one session shipped, how it handled failed tool calls, and anything
 *  passed as `children` (the extensions it used), as one quiet line. */
export function SessionOutcomes({ sessionId, onSelect, children }: { sessionId: string; onSelect: (sessionId: string, eventId?: number) => void; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { data: list } = useQuery({ queryKey: ['shipped', 0, sessionId], queryFn: () => getShipped(0, { sessionId }), enabled: open, staleTime: 60_000 });
  const { data: out } = useQuery({ queryKey: ['session-outcomes', sessionId], queryFn: () => getSessionOutcomes(sessionId), staleTime: 60_000 });
  const { data: rec } = useQuery({ queryKey: ['session-recovery', sessionId], queryFn: () => getSessionRecovery(sessionId), staleTime: 30_000 });
  const commits = out ? Math.max(out.commits, out.git_commits) : 0;
  const shipped = out && (commits || out.pushes || out.prs_opened);
  const stuck = rec?.chains.find((c) => c.outcome !== 'recovered') ?? rec?.chains[0];
  const unfixed = rec ? rec.failures - rec.recovered : 0;
  if (!shipped && !rec?.failures && !children) return null;
  return (
    <div className="sd-sig">
      {shipped ? (
        <button type="button" className="sd-sig-i" aria-expanded={open} onClick={() => setOpen((x) => !x)} title="List every PR, commit and push with links">
          <Icon name="branch" size={13} />
          {[
            commits > 0 && plural(commits, 'commit'),
            out.pushes > 0 && plural(out.pushes, 'push', 'pushes'),
            out.prs_opened > 0 && `${plural(out.prs_opened, 'PR')}${out.prs_merged ? `, ${out.prs_merged} merged` : ''}`,
          ].filter(Boolean).join(' · ')}
          {out.git_commits > 0 && (
            <span className="num-t" title={`${out.files} files changed in git`}>
              <span className="d-add">+{fmt.k(out.added)}</span> <span className="d-rm">−{fmt.k(out.removed)}</span>
            </span>
          )}
          <Icon name="down" size={12} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 160ms ease' }} />
        </button>
      ) : null}
      {rec && rec.failures > 0 && (
        <a
          href={stuck ? `#/session/${encodeURIComponent(sessionId)}?e=${stuck.event_id}` : undefined}
          className={`sd-sig-i${unfixed ? ' is-warn' : ''}`}
          title={`${rec.recovered} fixed${rec.avg_steps ? ` in ${rec.avg_steps} calls on average` : ''}, ${rec.moved_on} worked around, ${rec.abandoned} never recovered. Opens the ${unfixed ? 'first unfixed' : 'first'} failure.`}
        >
          <Icon name="bolt" size={13} />
          {plural(rec.failures, 'tool failure')}, {unfixed ? `${unfixed} not fixed` : 'all fixed'}
        </a>
      )}
      {children}
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
