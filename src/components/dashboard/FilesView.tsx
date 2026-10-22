import { useMemo, useState } from 'react';
import { getEdits, type EditsFeed } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { fmt } from '../forest/format';
import { Icon } from '../forest/icons';
import { Agent, Seg } from '../forest/ui';

const WINDOWS = [
  { k: 1, l: '1d' },
  { k: 7, l: '7d' },
  { k: 30, l: '30d' },
  { k: 0, l: 'all' },
];

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i > 0 ? rel.slice(0, i) : '';
}

function nameOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/**
 * Activity → Files: what agents changed most recently, by project and path. A row
 * opens the session on the edit that last touched the file.
 */
export function FilesView({ onSelect }: { onSelect: (sessionId: string, eventId?: number) => void }) {
  const [days, setDays] = useState(7);
  const [project, setProject] = useState<string | null>(null);
  const { data, error } = usePolling<EditsFeed>(['edits', days], () => getEdits(days), 30000);
  const items = useMemo(
    () => (data?.items ?? []).filter((f) => project === null || (f.project ?? '') === project),
    [data, project],
  );
  const now = new Date().toISOString();
  const t = data?.totals;

  return (
    <div className="scroll">
      <div className="page">
        <div className="ph">
          <div>
            <span className="label">Activity</span>
            <h1>Files</h1>
            <p>The files agents changed, newest first. Lines are what the agent asked to write.</p>
          </div>
          <Seg id="fe-range" value={days} options={WINDOWS} onChange={(d) => { setDays(d); setProject(null); }} />
        </div>

        <div className="kpis">
          {[
            { k: 'Files changed', v: t ? fmt.n(t.files) : null, d: t ? `${fmt.n(t.edits)} edits` : '' },
            { k: 'Lines added', v: t ? `+${fmt.k(t.added)}` : null, d: 'from edit inputs', cls: 'd-add' },
            { k: 'Lines removed', v: t ? `−${fmt.k(t.removed)}` : null, d: 'from edit inputs', cls: 'd-rm' },
            { k: 'Projects', v: t ? fmt.n(t.projects) : null, d: t?.truncated ? 'newest 20k edits' : 'with edits' },
          ].map((k) => (
            <div className="kpi" key={k.k}>
              <span className="label">{k.k}</span>
              {k.v == null ? <span className="sk" style={{ height: 34, width: 88 }} /> : <span className={`v ${k.cls ?? ''}`}>{k.v}</span>}
              <span className="d">{k.d}</span>
            </div>
          ))}
        </div>

        {error ? (
          <section className="card" style={{ marginTop: 16 }}>
            <div className="oc-empty"><b>Couldn't load edits</b><p>The collector didn't answer. It may be restarting; this retries on its own.</p></div>
          </section>
        ) : (
          <div className="oc-split-r">
            <section className="card" aria-labelledby="fe-proj" style={{ alignSelf: 'start' }}>
              <div className="card-h"><span className="card-t" id="fe-proj">Projects</span></div>
              <div className="card-b" style={{ paddingTop: 0 }}>
                {!data ? (
                  <div style={{ display: 'grid', gap: 8 }}>{[0, 1, 2, 3].map((i) => <span key={i} className="sk" style={{ height: 30 }} />)}</div>
                ) : (
                  <div className="oc-legend" style={{ gridTemplateColumns: '1fr', marginTop: 0 }}>
                    <button type="button" aria-pressed={project === null} onClick={() => setProject(null)}>
                      <i style={{ background: 'var(--v-hot)' }} /><span>All projects</span><span className="num-t dim">{fmt.n(data.totals.files)}</span>
                    </button>
                    {data.projects.map((p) => (
                      <button key={p.project ?? '-'} type="button" aria-pressed={project === (p.project ?? '')} onClick={() => setProject(project === (p.project ?? '') ? null : p.project ?? '')} title={p.project ?? 'No project'}>
                        <i style={{ background: 'var(--v-mute)' }} />
                        <span className="truncate">{p.project_name ?? 'no project'}</span>
                        <span className="num-t dim">{fmt.n(p.files)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="card" aria-labelledby="fe-files" style={{ overflow: 'hidden' }}>
              <div className="card-h"><span className="card-t" id="fe-files">Recently changed</span><span className="label">{items.length} files</span></div>
              {!data ? (
                <div className="card-b" style={{ display: 'grid', gap: 10 }}>{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className="sk" style={{ height: 36 }} />)}</div>
              ) : items.length === 0 ? (
                <div className="oc-empty">
                  <b>No edits {days ? `in the last ${days === 1 ? 'day' : `${days} days`}` : 'yet'}</b>
                  <p>Files show up here once an agent writes or edits one. Try a longer range, or check that hooks are installed under Governance.</p>
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="t t-compact">
                    <thead><tr><th>File</th><th>Agents</th><th className="num">Edits</th><th className="num">Lines</th><th className="num">Last</th></tr></thead>
                    <tbody>
                      {items.map((f, i) => (
                        <tr
                          key={`${f.project}:${f.path}`}
                          className="click fe-row rise"
                          style={{ ['--i' as string]: i }}
                          tabIndex={0}
                          onClick={() => onSelect(f.last.session_id, f.last.event_id)}
                          onKeyDown={(e) => e.key === 'Enter' && onSelect(f.last.session_id, f.last.event_id)}
                          title={`${f.path}\nOpen the session on this edit`}
                        >
                          <td style={{ maxWidth: 420 }}>
                            <span className="fe-path">
                              <b className="mono">{nameOf(f.relative)}</b>
                              <span className="mono"><bdi>{[project === null ? f.project_name : null, dirOf(f.relative)].filter(Boolean).join(' / ') || '—'}</bdi></span>
                            </span>
                          </td>
                          <td><span style={{ display: 'inline-flex', gap: 6 }}>{f.agents.map((a) => <Agent key={a} id={a} label={false} />)}</span></td>
                          <td className="num num-t">{f.edits}{f.failed > 0 && <span className="dim" title={`${f.failed} failed`}> · {f.failed}<Icon name="close" size={10} /></span>}</td>
                          <td className="num num-t" style={{ whiteSpace: 'nowrap' }}>
                            <span className="d-add">+{fmt.k(f.added)}</span>{' '}<span className="d-rm">−{fmt.k(f.removed)}</span>
                          </td>
                          <td className="num dim" style={{ whiteSpace: 'nowrap' }}>{fmt.ago(f.last.ts, now)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
