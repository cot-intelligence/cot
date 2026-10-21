import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { exportSessionHtml, scanSessionExport, sessionExportUrl, type ExportSuggestion, type Store } from '../../../lib/api';
import { Icon } from '../../forest/icons';
import { EASE_OUT } from '../../forest/motion';
import { Switch } from '../../forest/ui';

const FORMATS = [
  { k: 'json', label: 'JSON', hint: 'Every event, lossless' },
  { k: 'md', label: 'Markdown', hint: 'A readable transcript' },
  { k: 'html', label: 'HTML page…', hint: 'Branded, to share; you choose what to hide' },
] as const;

/** The session page's Export button: pick a format; HTML opens the redaction dialog first. */
export function ExportMenu({ sessionId, store }: { sessionId: string; store: Store }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const formats = store === 'main' ? FORMATS : FORMATS.filter((f) => f.k !== 'html');
  return (
    <div className="dd" ref={root}>
      <button type="button" className="vbtn vbtn-quiet vbtn-sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="download" size={14} />Export<Icon name="down" size={13} className="dd-chev" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="dd-pop xm-pop"
            role="menu"
            initial={{ opacity: 0, transform: 'translateY(-4px) scale(0.98)' }}
            animate={{ opacity: 1, transform: 'translateY(0px) scale(1)' }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}>
            <ul className="dd-l">
              {formats.map((f) =>
                f.k === 'html' ? (
                  <li key={f.k}>
                    <button type="button" role="menuitem" className="dd-o xm-o" onClick={() => { setOpen(false); setDialog(true); }}>
                      <span className="xm-l">{f.label}</span><span className="xm-h">{f.hint}</span>
                    </button>
                  </li>
                ) : (
                  <li key={f.k}>
                    <a role="menuitem" className="dd-o xm-o" href={sessionExportUrl(sessionId, store, f.k)} download onClick={() => setOpen(false)}>
                      <span className="xm-l">{f.label}</span><span className="xm-h">{f.hint}</span>
                    </a>
                  </li>
                ),
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
      <RedactDialog sessionId={sessionId} open={dialog} onClose={() => setDialog(false)} />
    </div>
  );
}

/**
 * Before an HTML export leaves the machine, the person decides what to hide.
 * cot only suggests: everything that might be a password or token is listed,
 * unticked, with where it appeared; they tick what to redact and can add their
 * own words (a client name, a hostname). Nothing is hidden unless chosen.
 */
function RedactDialog({ sessionId, open, onClose }: { sessionId: string; open: boolean; onClose: () => void }) {
  const reduce = useReducedMotion();
  const [thoughts, setThoughts] = useState(true);
  const [outputs, setOutputs] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [terms, setTerms] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isError, isFetching } = useQuery({
    queryKey: ['exportScan', sessionId, thoughts, outputs],
    queryFn: () => scanSessionExport(sessionId, { thoughts, outputs }),
    enabled: open,
    staleTime: 60_000,
  });
  const suggestions = data ?? [];

  useEffect(() => {
    if (!open) return;
    setError(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const toggle = (id: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const addTerm = () => {
    const t = draft.trim();
    if (t && !terms.some((x) => x.toLowerCase() === t.toLowerCase())) setTerms([...terms, t]);
    setDraft('');
  };
  const allPicked = suggestions.length > 0 && suggestions.every((s) => picked.has(s.id));

  const exportNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await exportSessionHtml(sessionId, {
        redact: suggestions.filter((s) => picked.has(s.id)).map((s) => s.id),
        terms: draft.trim() ? [...terms, draft.trim()] : terms,
        thoughts,
        outputs,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  const host = typeof document !== 'undefined' ? document.querySelector('.vf.app') ?? document.body : null;
  if (!host) return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="scrim" className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.14, ease: EASE_OUT } }} transition={{ duration: 0.2, ease: EASE_OUT }} />
          <div className="teams-wrap" key="dialog">
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="xr-title"
              className="xr-modal"
              initial={{ opacity: 0, transform: reduce ? 'none' : 'scale(0.96)' }}
              animate={{ opacity: 1, transform: 'scale(1)' }}
              exit={{ opacity: 0, transform: reduce ? 'none' : 'scale(0.98)', transition: { duration: 0.14, ease: EASE_OUT } }}
              transition={{ duration: 0.2, ease: EASE_OUT }}>
              <div className="xr-h">
                <div>
                  <span className="label">Export as HTML</span>
                  <h2 id="xr-title">Choose what to hide</h2>
                  <p className="dim">The page has the whole timeline: every prompt, reply and tool call with its output. Nothing is hidden unless you pick it here.</p>
                </div>
                <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
              </div>

              <div className="xr-b">
                <div className="xr-opts">
                  <label className="xr-opt"><span>Include thinking</span><Switch on={thoughts} onChange={setThoughts} label="Include thinking" /></label>
                  <label className="xr-opt"><span>Include tool output and file contents</span><Switch on={outputs} onChange={setOutputs} label="Include tool output" /></label>
                </div>

                <section aria-label="Possible secrets">
                  <div className="xr-sec-h">
                    <span className="label">Might be a password or token</span>
                    {suggestions.length > 0 && (
                      <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => setPicked(allPicked ? new Set() : new Set(suggestions.map((s) => s.id)))}>
                        {allPicked ? 'Clear all' : `Select all ${suggestions.length}`}
                      </button>
                    )}
                  </div>
                  {!data && !isError && <div className="xr-list" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} className="sk" style={{ height: 44 }} />)}</div>}
                  {isError && <p className="an-err">Couldn't scan the session. You can still add words to hide below.</p>}
                  {data && suggestions.length === 0 && <p className="dim xr-none">{isFetching ? 'Scanning…' : 'Nothing in this session looks like a password or token.'}</p>}
                  {suggestions.length > 0 && (
                    <ul className="xr-list">
                      {suggestions.map((s: ExportSuggestion) => (
                        <li key={s.id}>
                          <label className="xr-item" data-on={picked.has(s.id)}>
                            <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
                            <span className="xr-item-m">
                              <span className="xr-item-t"><span className="mono">{s.preview}</span><span className="faint">{s.kind}{s.count > 1 ? ` · ${s.count}×` : ''}</span></span>
                              <span className="xr-item-c mono truncate" title={s.context}>{s.context}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section aria-label="Your own words to hide">
                  <div className="xr-sec-h"><span className="label">Also hide these words</span></div>
                  <form className="xr-add" onSubmit={(e) => { e.preventDefault(); addTerm(); }}>
                    <input className="an-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="A client name, hostname, email…" aria-label="Word to hide" />
                    <button type="submit" className="vbtn vbtn-quiet vbtn-sm" disabled={!draft.trim()}>Add</button>
                  </form>
                  {terms.length > 0 && (
                    <div className="xr-terms">
                      {terms.map((t) => (
                        <span key={t} className="xr-term">
                          <span className="truncate">{t}</span>
                          <button type="button" aria-label={`Stop hiding ${t}`} onClick={() => setTerms(terms.filter((x) => x !== t))}><Icon name="close" size={12} /></button>
                        </span>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              <div className="xr-f">
                <span className="dim" role="status">
                  {error ? <span className="an-err">{error}</span> : `${picked.size + terms.length + (draft.trim() ? 1 : 0)} thing${picked.size + terms.length + (draft.trim() ? 1 : 0) === 1 ? '' : 's'} will be replaced with [redacted]`}
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={onClose}>Cancel</button>
                  <button type="button" className="vbtn vbtn-primary vbtn-sm" onClick={exportNow} disabled={busy}>
                    {busy ? 'Exporting…' : 'Export HTML'}<Icon name="download" size={14} />
                  </button>
                </span>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    host,
  );
}
