import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSessionAnnotations, putAnnotation, type Annotation, type Rating, type SessionAnnotations } from '../../../lib/api';
import { Icon } from '../../forest/icons';

/** Labels offered on every annotation; anything typed is kept as well. */
const SUGGESTED = ['worked well', 'wrong approach', 'looped', 'ignored instructions', 'made things up', 'wasted tokens'];

export function annotationsKey(sessionId: string) {
  return ['annotations', sessionId];
}

/** The session's annotations, shared by the header and every event row. */
export function useAnnotations(sessionId: string, enabled = true) {
  return useQuery({ queryKey: annotationsKey(sessionId), queryFn: () => getSessionAnnotations(sessionId), enabled });
}

/** Thumbs, labels and a note on the session (`eventId` unset) or one event. */
export function Feedback({ sessionId, eventId, compact = false, toolbar = false }: { sessionId: string; eventId?: number; compact?: boolean; toolbar?: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useAnnotations(sessionId);
  const current = eventId == null ? data?.session ?? null : data?.events.find((a) => a.event_id === eventId) ?? null;
  const [editing, setEditing] = useState(false);
  const [labels, setLabels] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) {
      setLabels(current?.labels ?? []);
      setNote(current?.note ?? '');
    }
  }, [current, editing]);

  const save = async (next: { rating: Rating | null; labels: string[]; note: string | null }) => {
    setSaving(true);
    try {
      const saved = await putAnnotation(sessionId, { event_id: eventId ?? null, ...next });
      queryClient.setQueryData<SessionAnnotations>(annotationsKey(sessionId), (prev) => merge(prev, saved, eventId));
    } finally {
      setSaving(false);
    }
  };

  const rate = (r: Rating) => save({ rating: current?.rating === r ? null : r, labels: current?.labels ?? [], note: current?.note ?? null });
  const toggleLabel = (l: string) => setLabels((ls) => (ls.includes(l) ? ls.filter((x) => x !== l) : [...ls, l]));
  const addCustom = () => {
    const l = custom.trim().toLowerCase();
    if (l && !labels.includes(l)) setLabels((ls) => [...ls, l]);
    setCustom('');
  };
  const submit = async () => {
    await save({ rating: current?.rating ?? null, labels, note: note.trim() || null });
    setEditing(false);
  };

  const size = compact ? 13 : 14;
  const what = eventId == null ? 'session' : 'event';
  return (
    <div className={toolbar ? 'fb-bar' : undefined} style={toolbar ? undefined : { display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {!compact && !toolbar && <span className="label" style={{ marginRight: 2 }}>Your take</span>}
        {([1, -1] as Rating[]).map((r) => {
          const on = current?.rating === r;
          return (
            <button
              key={r}
              type="button"
              className="vbtn vbtn-quiet vbtn-sm"
              aria-pressed={on}
              aria-label={`${r === 1 ? 'Good' : 'Bad'} ${what}`}
              title={on ? 'Clear rating' : `Mark this ${what} as ${r === 1 ? 'good' : 'bad'}`}
              disabled={saving}
              onClick={() => void rate(r)}
              style={on ? { borderColor: r === 1 ? 'var(--v-olive)' : 'var(--v-alert)', color: r === 1 ? 'var(--v-olive)' : 'var(--v-alert)' } : undefined}>
              <Icon name={r === 1 ? 'thumb-up' : 'thumb-down'} size={size} />
            </button>
          );
        })}
        {toolbar ? (
          <button
            type="button"
            className="vbtn vbtn-quiet vbtn-sm"
            aria-expanded={editing}
            aria-label={current?.labels.length || current?.note ? 'Edit note' : 'Add note'}
            title={[...(current?.labels ?? []), current?.note].filter(Boolean).join(' · ') || 'Add a note'}
            onClick={() => setEditing((e) => !e)}
            style={current?.labels.length || current?.note ? { color: 'var(--v-fg)' } : undefined}>
            <Icon name="edit" size={size} />
          </button>
        ) : (
          <button type="button" className="vbtn vbtn-ghost vbtn-sm" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
            {current?.labels.length || current?.note ? 'Edit note' : 'Add note'}
          </button>
        )}
        {!editing && !toolbar && current?.labels.map((l) => <span key={l} className="vchip c-dim" style={{ textTransform: 'none', letterSpacing: 0 }}>{l}</span>)}
      </div>
      {!editing && !toolbar && current?.note && <p className="dim" style={{ margin: 0, fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{current.note}</p>}
      {editing && (
        <div className={`card${toolbar ? ' fb-pop' : ''}`} style={{ padding: 12, display: 'grid', gap: 10, maxWidth: 560 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[...SUGGESTED, ...labels.filter((l) => !SUGGESTED.includes(l))].map((l) => (
              <button key={l} type="button" className={`vchip ${labels.includes(l) ? 'c-fg' : 'c-dim'}`} aria-pressed={labels.includes(l)} onClick={() => toggleLabel(l)} style={{ border: 0, cursor: 'pointer', textTransform: 'none', letterSpacing: 0 }}>
                {labels.includes(l) && <Icon name="check" size={11} />}
                {l}
              </button>
            ))}
            <label className="vfield" style={{ width: 140, height: 26 }}>
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
                onBlur={addCustom}
                placeholder="Other label"
                aria-label="Add a label"
                maxLength={40}
                style={{ fontSize: 12 }}
              />
            </label>
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`What happened in this ${what}?`}
            aria-label="Note"
            rows={3}
            maxLength={4000}
            className="vtext"
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="vbtn vbtn-primary vbtn-sm" disabled={saving} onClick={() => void submit()}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A small mark on a timeline row the person rated. */
export function RatingMark({ annotation }: { annotation: Annotation | undefined }) {
  if (!annotation || (annotation.rating == null && !annotation.note && !annotation.labels.length)) return null;
  const up = annotation.rating === 1;
  const down = annotation.rating === -1;
  return (
    <span className={`vchip ${up ? 'c-ok' : down ? 'c-critical' : 'c-dim'}`} style={{ marginLeft: 8 }} title={[...annotation.labels, annotation.note].filter(Boolean).join(' · ') || undefined}>
      <Icon name={up ? 'thumb-up' : down ? 'thumb-down' : 'edit'} size={11} />
      {annotation.labels[0] ?? (up ? 'good' : down ? 'bad' : 'note')}
    </span>
  );
}

function merge(prev: SessionAnnotations | undefined, saved: Annotation, eventId: number | undefined): SessionAnnotations {
  const base = prev ?? { session: null, events: [] };
  const empty = saved.rating == null && !saved.labels.length && !saved.note;
  if (eventId == null) return { ...base, session: empty ? null : saved };
  const events = base.events.filter((a) => a.event_id !== eventId);
  return { ...base, events: empty ? events : [...events, saved] };
}
