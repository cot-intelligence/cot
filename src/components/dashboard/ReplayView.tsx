import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteReplaySession,
  getReplaySessions,
  importReplaySession,
  sessionExportUrl,
  setImportNote,
  type SessionSummary,
} from '../../lib/api';
import { sessionHref } from '../../lib/sessionStore';
import { fmt, project, shortId } from '../forest/format';
import { Icon } from '../forest/icons';
import { EASE_OUT } from '../forest/motion';
import { Agent } from '../forest/ui';

const REPLAY_KEY = ['replaySessions'];

/**
 * Session Replay: sessions imported from exported JSON files. The collector
 * keeps them in their own DB, so they never mix with traced sessions or count
 * toward Overview and Activity. Markup follows the Sessions page.
 */
export function ReplayView() {
  const queryClient = useQueryClient();
  const { data: sessions, isPending, isError } = useQuery({
    queryKey: REPLAY_KEY,
    queryFn: getReplaySessions,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Choosing a file opens the context dialog; editing a row's context reuses it.
  const [dialog, setDialog] = useState<NoteDialogState | null>(null);

  const chosen = (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = '';
    if (file) setDialog({ kind: 'import', file });
  };

  const importFile = async (file: File, note: string) => {
    setImporting(true);
    setError(null);
    try {
      const result = await importReplaySession(file);
      // The note is optional context: a failure to save it shouldn't undo the import.
      if (note.trim()) await setImportNote(result.session_id, note).catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: REPLAY_KEY });
      setDialog(null);
      window.location.hash = sessionHref(result.session_id, 'replay');
    } catch (e) {
      setDialog(null);
      setError(`${file.name}: ${e instanceof Error ? e.message : 'import failed'}`);
    } finally {
      setImporting(false);
    }
  };

  const saveNote = async (id: string, note: string) => {
    await setImportNote(id, note);
    await queryClient.invalidateQueries({ queryKey: REPLAY_KEY });
    setDialog(null);
  };

  const remove = async (id: string) => {
    await deleteReplaySession(id);
    await queryClient.invalidateQueries({ queryKey: REPLAY_KEY });
  };

  const pick = () => inputRef.current?.click();
  const now = new Date().toISOString();

  return (
    <div className="scroll" id="vf-scroll">
      <div className="page">
        <div className="ph">
          <div>
            <span className="label">Monitor</span>
            <h1>Session Replay</h1>
            <p>Sessions imported from exported JSON files. They're kept apart from your traced sessions and don't count toward Overview or Activity.</p>
          </div>
          <input ref={inputRef} type="file" accept="application/json,.json" hidden onChange={(e) => chosen(e.target.files?.[0])} />
          <button type="button" className="vbtn vbtn-primary" disabled={importing} onClick={pick}>
            <Icon name="upload" size={15} />
            {importing ? 'Importing…' : 'Import JSON'}
          </button>
        </div>

        {error && (
          <div role="alert" className="finding" style={{ marginBottom: 16 }}>
            <span className="meta" style={{ color: 'var(--v-alert)' }}>Import failed</span>
            <span className="ttl">{error}</span>
          </div>
        )}

        <div className="card" style={{ overflow: 'hidden' }}>
          {isPending ? (
            <div className="empty">Loading imported sessions…</div>
          ) : isError ? (
            <div className="empty" style={{ color: 'var(--v-alert)' }}>Couldn't load imported sessions.</div>
          ) : sessions && sessions.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Agent</th>
                    <th className="num">Events</th>
                    <th className="num">Duration</th>
                    <th>Recorded</th>
                    <th>Imported</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <ReplayRow key={s.id} s={s} now={now} onDelete={remove} onEditNote={() => setDialog({ kind: 'edit', session: s })} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              <Icon name="replay" size={22} style={{ margin: '0 auto 10px', color: 'var(--v-faint)' }} />
              <p style={{ margin: 0, color: 'var(--v-fg)', fontWeight: 500 }}>No imported sessions yet</p>
              <p style={{ margin: '4px auto 16px', maxWidth: 380, fontSize: 13 }}>
                Export a session from its page or the Sessions drawer, then import the .json file here to replay it.
              </p>
              <button type="button" className="vbtn vbtn-quiet vbtn-sm" disabled={importing} onClick={pick}>
                <Icon name="upload" size={14} /> Import JSON
              </button>
            </div>
          )}
        </div>
      </div>
      <NoteDialog
        state={dialog}
        busy={importing}
        onClose={() => !importing && setDialog(null)}
        onSubmit={(note) => {
          if (!dialog) return;
          if (dialog.kind === 'import') void importFile(dialog.file, note);
          else void saveNote(dialog.session.id, note);
        }}
      />
    </div>
  );
}

type NoteDialogState = { kind: 'import'; file: File } | { kind: 'edit'; session: SessionSummary };

const NOTE_MAX = 2000;

function NoteDialog({ state, busy, onClose, onSubmit }: { state: NoteDialogState | null; busy: boolean; onClose: () => void; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState('');
  useEffect(() => {
    if (state) setNote(state.kind === 'edit' ? state.session.import_note ?? '' : '');
  }, [state]);
  const importing = state?.kind === 'import';

  return (
    <AnimatePresence>
      {state && (
        <motion.div
          className="pal-scrim"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ duration: 0.16 }}>
          <motion.form
            className="pal note-dlg"
            role="dialog"
            aria-modal="true"
            aria-labelledby="note-dlg-h"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(note); }
            }}
            onSubmit={(e) => { e.preventDefault(); onSubmit(note); }}
            initial={{ opacity: 0, transform: 'translateY(8px) scale(0.98)' }}
            animate={{ opacity: 1, transform: 'translateY(0px) scale(1)' }}
            exit={{ opacity: 0, transform: 'translateY(4px) scale(0.99)', transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: EASE_OUT }}>
            <span className="label">{importing ? 'Import session' : 'Edit context'}</span>
            <h2 id="note-dlg-h" style={{ marginTop: 6 }}>{importing ? 'Add context for this trace' : 'Context'}</h2>
            <p className="mono faint truncate" style={{ fontSize: 11, margin: '4px 0 14px' }}>
              {state.kind === 'import'
                ? `${state.file.name} · ${fmtBytes(state.file.size)}`
                : `${project(state.session.cwd)} · from ${shortId(state.session.imported_from ?? state.session.id)}`}
            </p>
            <label htmlFor="note-dlg-t" className="dim" style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>
              Why are you importing it? Optional, shown with the session.
            </label>
            <textarea
              id="note-dlg-t"
              className="vtext"
              autoFocus
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Repro of the failed deploy from Priya's machine. Look at the second migration run."
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
              <span className="mono faint" style={{ fontSize: 11 }}>{note.length > NOTE_MAX * 0.8 ? `${note.length}/${NOTE_MAX}` : '⌘↵ to save'}</span>
              <button type="button" className="vbtn vbtn-quiet" style={{ marginLeft: 'auto' }} onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="vbtn vbtn-primary" disabled={busy}>
                {importing ? (busy ? 'Importing…' : note.trim() ? 'Import with context' : 'Import') : 'Save'}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ReplayRow({ s, now, onDelete, onEditNote }: { s: SessionSummary; now: string; onDelete: (id: string) => Promise<void>; onEditNote: () => void }) {
  // Delete asks for a second click rather than a browser dialog, which the
  // desktop app's webview may not show.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirming]);

  const open = () => {
    window.location.hash = sessionHref(s.id, 'replay');
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <tr className="click" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()}>
      <td style={{ maxWidth: 440 }}>
        <span className="truncate" style={{ display: 'block', fontWeight: 500 }}>
          {s.title || `Session ${shortId(s.imported_from ?? s.id)}`}
        </span>
        <span className="mono faint" style={{ fontSize: 11 }} title={s.imported_from ? `Original session ${s.imported_from}` : undefined}>
          {project(s.cwd)}{s.imported_from ? ` · from ${shortId(s.imported_from)}` : ''}
        </span>
        {s.import_note && <span className="note-txt" title={s.import_note}>{s.import_note}</span>}
      </td>
      <td><Agent id={s.source} /></td>
      <td className="num">{s.event_count}</td>
      <td className="num">{fmt.dur(s.duration_seconds ?? 0)}</td>
      <td className="mono dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmt.day(s.started_at)}</td>
      <td className="mono dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{s.imported_at ? fmt.ago(s.imported_at, now) : '—'}</td>
      <td onClick={stop} onKeyDown={stop}>
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <button type="button" className="iconbtn" onClick={onEditNote} aria-label={s.import_note ? 'Edit context' : 'Add context'} title={s.import_note ? 'Edit context' : 'Add context'}>
            <Icon name="edit" size={15} />
          </button>
          <a className="iconbtn" href={sessionExportUrl(s.id, 'replay')} download aria-label="Export session as JSON" title="Export as JSON">
            <Icon name="download" size={15} />
          </a>
          <button
            type="button"
            className={confirming ? 'vbtn vbtn-sm' : 'iconbtn'}
            style={confirming ? { color: 'var(--v-alert)', borderColor: 'var(--v-alert)' } : undefined}
            onClick={() => (confirming ? void onDelete(s.id) : setConfirming(true))}
            aria-label={confirming ? 'Confirm delete' : 'Delete imported session'}
            title={confirming ? 'Click again to delete' : 'Delete imported session'}>
            {confirming ? 'Delete?' : <Icon name="trash" size={15} />}
          </button>
        </div>
      </td>
    </tr>
  );
}
