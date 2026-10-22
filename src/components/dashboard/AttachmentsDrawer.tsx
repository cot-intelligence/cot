import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { getAttachments, type AttachmentRow } from '../../lib/api';
import { agentLabel } from '../forest/AgentMark';
import { fmt, project, shortId } from '../forest/format';
import { Icon } from '../forest/icons';
import { EASE_OUT } from '../forest/motion';

/** Same label as the Overview word cloud: media subtype, else extension, upper-cased. */
export function attachmentType(a: Pick<AttachmentRow, 'media_type' | 'extension'>): string {
  const raw = a.media_type || a.extension || '';
  return (raw.includes('/') ? raw.split('/').pop()! : raw).toUpperCase() || 'FILE';
}

function attachmentName(a: AttachmentRow): string {
  if (a.name) return a.name;
  if (a.kind === 'image') return a.width && a.height ? `Pasted image · ${a.width}×${a.height}` : 'Pasted image';
  return 'Attached file';
}

/**
 * Every file attached to a prompt, newest first. Agents pass along a file's
 * name, type and size but not where it lived on disk, so each row's location
 * is the project and session it went into; a click opens that prompt in the
 * timeline.
 *
 * Motion: the same right-hand drawer as elsewhere in the app (drawer curve in,
 * a faster ease-out exit); with reduced motion it only fades.
 */
export function AttachmentsDrawer({
  open,
  initialType,
  onClose,
  onOpen,
}: {
  open: boolean;
  initialType?: string | null;
  onClose: () => void;
  onOpen: (sessionId: string, eventId: number) => void;
}) {
  const reduce = useReducedMotion();
  const { data, error } = useQuery({ queryKey: ['attachments'], queryFn: () => getAttachments(1000), enabled: open, staleTime: 30_000 });
  const [type, setType] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (open) {
      setType(initialType ?? null);
      setQ('');
    }
  }, [open, initialType]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of data ?? []) counts.set(attachmentType(a), (counts.get(attachmentType(a)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter(
      (a) =>
        (!type || attachmentType(a) === type) &&
        (!needle || [a.name, a.cwd, a.path, a.session_id].some((v) => v?.toLowerCase().includes(needle))),
    );
  }, [data, type, q]);

  const host = typeof document !== 'undefined' ? document.querySelector('.vf.app') ?? document.body : null;
  if (!host) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="scrim" className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
          <motion.aside
            key="drawer"
            className="drawer att-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="att-title"
            initial={reduce ? { opacity: 0 } : { transform: 'translateX(105%)' }}
            animate={reduce ? { opacity: 1 } : { transform: 'translateX(0%)' }}
            exit={reduce ? { opacity: 0 } : { transform: 'translateX(105%)', transition: { duration: 0.2, ease: EASE_OUT } }}
            transition={{ duration: 0.38, ease: [0.32, 0.72, 0, 1] }}>
            <div className="drawer-h">
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="label">Attachments</span>
                <h2 id="att-title" style={{ margin: '4px 0 0', fontSize: 17, lineHeight: '24px', fontWeight: 600, letterSpacing: '-0.01em' }}>
                  {data ? `${fmt.n(data.length)} file${data.length === 1 ? '' : 's'} attached to prompts` : 'Files attached to prompts'}
                </h2>
              </div>
              <button type="button" className="iconbtn" onClick={onClose} aria-label="Close" autoFocus><Icon name="close" /></button>
            </div>
            <div className="att-tools">
              <label className="vfield" style={{ width: '100%' }}>
                <Icon name="search" size={15} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, project or session" aria-label="Filter attachments" />
              </label>
              {types.length > 1 && (
                <div className="att-types" role="radiogroup" aria-label="File type">
                  <button type="button" role="radio" aria-checked={!type} className="psv-chip" onClick={() => setType(null)}>All</button>
                  {types.map(([t, n]) => (
                    <button key={t} type="button" role="radio" aria-checked={type === t} className="psv-chip" onClick={() => setType(type === t ? null : t)}>
                      {t} <span className="faint tnum">{n}</span>
                    </button>
                  ))}
                </div>
              )}
              <p className="att-note">
                <Icon name="folder" size={13} />
                Agents send the name, type and size, not the file&rsquo;s path, so each row shows the session it went into.
              </p>
            </div>
            <div className="drawer-b" style={{ paddingTop: 0 }}>
              {error ? (
                <p className="dim" style={{ fontSize: 13 }}>Couldn&rsquo;t load attachments. Is the collector running?</p>
              ) : !data ? (
                <ul className="att-list" aria-busy="true">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <li key={i} className="att-row" style={{ cursor: 'default' }}>
                      <span className="sk" style={{ width: 34, height: 34, borderRadius: 8 }} />
                      <span style={{ display: 'grid', gap: 6 }}><span className="sk" style={{ height: 12, width: '70%' }} /><span className="sk" style={{ height: 10, width: '45%' }} /></span>
                    </li>
                  ))}
                </ul>
              ) : rows.length === 0 ? (
                <div className="empty" style={{ padding: '32px 0' }}>{data.length ? 'No attachments match.' : 'No files have been attached to a prompt yet.'}</div>
              ) : (
                <ul className="att-list">
                  {rows.map((a) => (
                    <li key={`${a.event_id}:${a.index}`}>
                      <button type="button" className="att-row" onClick={() => onOpen(a.session_id, a.event_id)} title="Open this prompt in the timeline">
                        <span className="att-ic" data-kind={a.kind}>
                          <Icon name={a.kind === 'image' ? 'eye' : 'file'} size={15} />
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <span className="att-name truncate">{attachmentName(a)}</span>
                          <span className="att-where mono truncate" title={a.path ?? a.cwd ?? ''}>
                            {a.path ?? `${project(a.cwd)} · ${agentLabel(a.source)} · ${shortId(a.session_id)}`}
                          </span>
                        </span>
                        <span className="att-meta mono">
                          <span className="vchip c-dim">{attachmentType(a)}</span>
                          <span className="faint">{a.size_bytes ? fmt.bytes(a.size_bytes) : ''}</span>
                          <span className="faint">{fmt.dayTime(a.ts)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    host,
  );
}
