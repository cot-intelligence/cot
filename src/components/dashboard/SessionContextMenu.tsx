import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sessionExportUrl, type SessionSummary } from '../../lib/api';
import { Icon } from '../forest/icons';
import { EASE_OUT } from '../forest/motion';

export type SessionAction = 'open' | 'copy-id' | 'copy-path' | 'bookmark' | 'export-json' | 'export-md' | 'archive' | 'delete';

interface Item {
  action: SessionAction;
  label: string;
  icon: string;
  danger?: boolean;
  /** Rendered as a download link instead of a button. */
  href?: string;
}

const MENU_W = 232;
const EDGE = 8;

function items(s: SessionSummary, archived: boolean): Item[][] {
  const id = encodeURIComponent(s.id);
  return [
    [
      { action: 'open', label: 'Open timeline', icon: 'trace' },
      { action: 'copy-id', label: 'Copy session ID', icon: 'copy' },
      ...(s.cwd ? [{ action: 'copy-path' as const, label: 'Copy project path', icon: 'folder' }] : []),
    ],
    [
      { action: 'bookmark', label: s.bookmarked ? 'Remove bookmark' : 'Bookmark', icon: 'star' },
      { action: 'export-json', label: 'Export as JSON', icon: 'download', href: sessionExportUrl(s.id) },
      { action: 'export-md', label: 'Export as Markdown', icon: 'download', href: `/v1/sessions/${id}/export?format=md` },
      { action: 'archive', label: archived ? 'Restore from archive' : 'Archive', icon: 'archive' },
    ],
    [{ action: 'delete', label: 'Delete session…', icon: 'trash', danger: true }],
  ];
}

/**
 * Right-click menu for a session row: open, copy, export, bookmark, archive and
 * delete without leaving the list.
 *
 * Opens at the pointer (or under the row's menu button), clamped to the
 * viewport, and scales in from the corner nearest the pointer. It's opened
 * often, so the entrance is short (120 ms) and the exit is instant. Arrow keys
 * move, Enter picks, Escape or a click elsewhere closes and focus goes back
 * to the row.
 */
export function SessionContextMenu({
  session,
  at,
  archived,
  onAction,
  onClose,
}: {
  session: SessionSummary | null;
  at: { x: number; y: number } | null;
  archived: boolean;
  onAction: (action: SessionAction, s: SessionSummary) => void;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const open = !!session && !!at;

  useLayoutEffect(() => {
    if (!open || !at) return setPos(null);
    const h = ref.current?.offsetHeight ?? 300;
    const flipX = at.x + MENU_W + EDGE > window.innerWidth;
    const flipY = at.y + h + EDGE > window.innerHeight;
    setPos({
      left: Math.max(EDGE, flipX ? at.x - MENU_W : at.x),
      top: Math.max(EDGE, flipY ? at.y - h : at.y),
      origin: `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`,
    });
  }, [open, at]);

  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onScroll = () => onClose();
    document.addEventListener('mousedown', away);
    window.addEventListener('resize', onScroll);
    document.getElementById('vf-scroll')?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', away);
      window.removeEventListener('resize', onScroll);
      document.getElementById('vf-scroll')?.removeEventListener('scroll', onScroll);
      back?.focus?.();
    };
  }, [open, onClose]);

  const onKey = (e: React.KeyboardEvent) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); all[all.length - 1]?.focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); onClose(); }
  };

  const host = typeof document !== 'undefined' ? document.querySelector('.vf.app') ?? document.body : null;
  if (!host) return null;

  return createPortal(
    <AnimatePresence>
      {open && session && (
        <motion.div
          ref={ref}
          key={`${session.id}:${at?.x}:${at?.y}`}
          className="ctx"
          role="menu"
          aria-label={`Actions for ${session.title || 'session'}`}
          onKeyDown={onKey}
          onContextMenu={(e) => e.preventDefault()}
          // Hover moves focus, so arrow keys carry on from the pointer and only one item is ever lit.
          onMouseMove={(e) => {
            const item = (e.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]');
            if (item && item !== document.activeElement) item.focus({ preventScroll: true });
          }}
          style={{ left: pos?.left ?? at?.x, top: pos?.top ?? at?.y, transformOrigin: pos?.origin ?? 'top left', visibility: pos ? 'visible' : 'hidden' }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.97)' }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, transform: 'scale(1)' }}
          exit={{ opacity: 0, transition: { duration: 0 } }}
          transition={{ duration: 0.12, ease: EASE_OUT }}>
          {items(session, archived).map((group, gi) => (
            <div key={gi} className="ctx-g" role="group">
              {group.map((it) =>
                it.href ? (
                  <a key={it.action} role="menuitem" tabIndex={-1} className="ctx-i" href={it.href} download onClick={() => onClose()}>
                    <Icon name={it.icon} size={14} />
                    {it.label}
                  </a>
                ) : (
                  <button
                    key={it.action}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="ctx-i"
                    data-danger={it.danger || undefined}
                    onClick={() => {
                      onClose();
                      onAction(it.action, session);
                    }}>
                    <Icon name={it.icon} size={14} style={it.action === 'bookmark' && session.bookmarked ? { fill: 'currentColor' } : undefined} />
                    {it.label}
                  </button>
                ),
              )}
            </div>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    host,
  );
}

/**
 * Confirms a permanent session delete. Cancel has focus, so Enter is the safe
 * choice; Escape and the scrim also cancel.
 */
export function DeleteSessionDialog({
  session,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  session: SessionSummary | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const reduce = useReducedMotion();
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!session) return;
    const raf = requestAnimationFrame(() => cancel.current?.focus());
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
    };
  }, [session, busy, onCancel]);

  const host = typeof document !== 'undefined' ? document.querySelector('.vf.app') ?? document.body : null;
  if (!host) return null;

  return createPortal(
    <AnimatePresence>
      {session && (
        <>
          <motion.div key="scrim" className="scrim" onClick={() => !busy && onCancel()} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.14 } }} transition={{ duration: 0.2, ease: EASE_OUT }} />
          <div className="teams-wrap" key="dialog">
            <motion.div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="del-title"
              aria-describedby="del-desc"
              className="teams-modal"
              initial={{ opacity: 0, transform: reduce ? 'none' : 'scale(0.96)' }}
              animate={{ opacity: 1, transform: 'scale(1)' }}
              exit={{ opacity: 0, transform: reduce ? 'none' : 'scale(0.98)', transition: { duration: 0.14, ease: EASE_OUT } }}
              transition={{ duration: 0.2, ease: EASE_OUT }}>
              <span className="teams-ic del-ic" aria-hidden="true"><Icon name="trash" size={18} /></span>
              <h2 id="del-title">Delete this session?</h2>
              <p id="del-desc" className="dim">
                <b style={{ color: 'var(--v-fg)', fontWeight: 500 }}>{session.title || 'Untitled session'}</b> and its{' '}
                {session.event_count} events, subagent sessions and notes are removed from cot for good. The agent&rsquo;s own
                transcript on disk is left alone. Archive it instead if you only want it out of the list.
              </p>
              {error && <p className="del-err" role="alert">{error}</p>}
              <div className="teams-actions">
                <button ref={cancel} type="button" className="vbtn vbtn-ghost vbtn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
                <button type="button" className="vbtn vbtn-danger vbtn-sm" onClick={onConfirm} disabled={busy}>
                  {busy ? 'Deleting…' : 'Delete session'}
                </button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    host,
  );
}
