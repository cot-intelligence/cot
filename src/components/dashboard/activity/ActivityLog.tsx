import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { getActivityLog, type ActivityCategory, type ActivityFilters } from '../../../lib/api';
import { fmt, project as fproject } from '../../forest/format';
import { Icon as FIcon } from '../../forest/icons';
import { Agent } from '../../forest/ui';
import { Dropdown } from '../../forest/Dropdown';

export type LogStatus = 'all' | 'failed' | 'risky';

const PAGE = 20;

interface ActivityLogProps {
  category: ActivityCategory;
  filters: ActivityFilters;
  /** Program (shell) or domain (web) picked from Most used; cleared with ×. */
  group: string | null;
  onClearGroup: () => void;
  status: LogStatus;
  /** Kept for callers; the status switch now sits in the card header. */
  onStatus?: (s: LogStatus) => void;
  /** Wrapper counts for the window, for the Via filter (shell only). */
  viaOptions?: { key: string; runs: number }[];
  onSelect: (sessionId: string, eventId?: number) => void;
}

export function viaLabel(key: string): string {
  if (key === 'env') return 'env vars';
  if (key === 'sudo') return 'sudo (as root)';
  return key;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ActivityLog({
  category,
  filters,
  group,
  onClearGroup,
  status,
  viaOptions = [],
  onSelect,
}: ActivityLogProps) {
  const [q, setQ] = useState('');
  const [via, setVia] = useState('');
  const query = useDebounced(q.trim(), 250);
  useEffect(() => {
    setQ('');
    setVia('');
  }, [category]);

  const log = useInfiniteQuery({
    queryKey: ['activityLog', category, filters, group, status, query, via],
    queryFn: ({ pageParam }) =>
      getActivityLog(category, {
        ...filters,
        q: query || undefined,
        group: group ?? undefined,
        failed: status === 'failed',
        risky: status === 'risky',
        via: via || undefined,
        offset: pageParam,
        limit: PAGE,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  const total = log.data?.pages[0]?.total ?? 0;
  const noun = category === 'shell' ? 'commands' : 'requests';

  const filtered = !!(query || group || via || status !== 'all');

  // Table markup mirrors the demo's command log (demo-variants/src/variants/forest/pages-b.tsx). The status
  // switch lives in the card header (MetricsHistoryView); search, via, the program chip and paging stay here.
  return (
    <>
      <div className="toolbar" style={{ padding: '0 20px', marginBottom: 12 }}>
        <label className="vfield" style={{ flex: '1 1 260px' }}>
          <FIcon name="search" size={15} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={category === 'shell' ? 'Filter commands' : 'Filter URLs and searches'} aria-label={`Filter ${noun}`} style={{ width: '100%' }} />
        </label>
        {category === 'shell' && viaOptions.length > 0 && (
          <Dropdown
            label="Ran through"
            value={via}
            onChange={setVia}
            options={[
              { value: '', label: 'Via: any' },
              ...viaOptions.map((v) => ({ value: v.key, label: `Via ${viaLabel(v.key)}`, meta: v.runs.toLocaleString() })),
              ...(via && !viaOptions.some((v) => v.key === via) ? [{ value: via, label: `Via ${viaLabel(via)}` }] : []),
            ]}
          />
        )}
        {group && (
          <span className="vchip c-fg" style={{ height: 26, paddingRight: 2 }}>
            {group}
            <button type="button" className="iconbtn" style={{ width: 20, height: 20 }} onClick={onClearGroup} aria-label={`Show all, not just ${group}`}><FIcon name="close" size={12} /></button>
          </span>
        )}
        <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{log.isPending ? 'Loading…' : `${total.toLocaleString()} ${noun}`}</span>
      </div>

      <div style={{ overflowX: 'auto', borderTop: '1px solid var(--v-line)' }}>
        {log.isError ? (
          <div className="empty">Collector offline. Activity is unavailable.</div>
        ) : log.isPending ? (
          <div style={{ padding: '8px 20px' }} aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => <span key={i} className="sk" style={{ display: 'block', height: 14, margin: '12px 0', width: `${60 + ((i * 13) % 35)}%` }} />)}
          </div>
        ) : items.length === 0 ? (
          <div className="empty">{filtered ? `No ${noun} match these filters.` : `No ${noun} in this time range. Try a longer range.`}</div>
        ) : (
          <table className="t">
            <thead><tr><th>Time</th><th>{category === 'shell' ? 'Command' : 'Request'}</th><th>Project</th><th>Agent</th><th className="num">Took</th><th>Result</th></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr
                  key={i.event_id}
                  className="click"
                  tabIndex={0}
                  onClick={() => onSelect(i.session_id, i.event_id)}
                  onKeyDown={(e) => e.key === 'Enter' && onSelect(i.session_id, i.event_id)}
                  title={[i.target, i.via?.length ? `Via ${i.via.map(viaLabel).join(', ')}` : '', i.env_names?.length ? `Sets ${i.env_names.join(', ')}` : '', i.error?.message ?? ''].filter(Boolean).join('\n')}
                  style={i.risk ? { background: 'color-mix(in srgb, var(--v-alert) 7%, transparent)' } : undefined}>
                  <td className="mono dim" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{i.ts ? fmt.dayTime(i.ts) : ''}</td>
                  <td className="mono" style={{ fontSize: 12, maxWidth: 420 }}>
                    <span className="truncate" style={{ display: 'block' }}>
                      {category === 'web' && <FIcon name={i.kind === 'search' ? 'search' : 'globe'} size={12} style={{ display: 'inline', verticalAlign: -1, marginRight: 6, color: 'var(--v-faint)' }} />}
                      {i.tool && category === 'shell' && <span className="dim" style={{ marginRight: 6 }}>{i.tool}</span>}
                      {category === 'shell' ? i.core || i.target : i.target}
                    </span>
                    {i.failed && i.error?.message && <span className="truncate" style={{ display: 'block', fontSize: 11, color: 'var(--v-alert)' }}>{i.error.exit_code != null ? `exit ${i.error.exit_code} · ` : ''}{i.error.message}</span>}
                  </td>
                  <td className="mono dim" style={{ fontSize: 12 }}>{fproject(i.cwd)}</td>
                  <td><Agent id={i.source} label={false} /></td>
                  <td className="num">{i.duration_ms ? fmt.ms(i.duration_ms) : ''}</td>
                  <td>
                    {i.risk ? <span className={`vchip c-${i.risk.severity}`}>{i.risk.label}</span>
                      : i.failed ? <span className="vchip c-warn">failed</span>
                      : i.no_match ? <span className="vchip c-dim" title="Exit 1: no match">no match</span>
                      : <span className="vchip c-ok">ok</span>}
                    {i.elevated && <span className="vchip c-warn" style={{ marginLeft: 4 }}>sudo</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {log.hasNextPage && (
        <div style={{ padding: 12, textAlign: 'center', borderTop: '1px solid var(--v-line)' }}>
          <button type="button" className="vbtn vbtn-quiet vbtn-sm" onClick={() => log.fetchNextPage()} disabled={log.isFetchingNextPage}>
            {log.isFetchingNextPage ? 'Loading…' : `Show ${Math.min(PAGE, total - items.length)} more`}
          </button>
        </div>
      )}
    </>
  );
}
