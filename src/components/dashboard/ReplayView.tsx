import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteReplaySession,
  getReplaySessions,
  importReplaySession,
  sessionExportUrl,
  type SessionSummary,
} from '../../lib/api';
import { formatRelative } from '../../lib/categoryMeta';
import { sessionHref } from '../../lib/sessionStore';
import { FadeIn } from '../ui/FadeIn';
import { Icon } from '../ui/icons';
import { PageHeader } from '../ui/PageHeader';
import { SourceBadge } from '../ui/SourceBadge';

const REPLAY_KEY = ['replaySessions'];

/**
 * Session Replay: sessions imported from exported JSON files. The collector
 * keeps them in their own DB, so they never mix with traced sessions or count
 * toward Overview and Activity.
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

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    setError(null);
    try {
      const result = await importReplaySession(file);
      await queryClient.invalidateQueries({ queryKey: REPLAY_KEY });
      window.location.hash = sessionHref(result.session_id, 'replay');
    } catch (e) {
      setError(`${file.name}: ${e instanceof Error ? e.message : 'import failed'}`);
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (id: string) => {
    await deleteReplaySession(id);
    await queryClient.invalidateQueries({ queryKey: REPLAY_KEY });
  };

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-8 px-6 py-10 sm:px-8">
        <FadeIn>
          <PageHeader
            eyebrow="Imported"
            title="Session Replay"
            description="Sessions imported from exported JSON files. They're kept apart from your traced sessions and don't count toward Overview or Activity."
            actions={
              <>
                <input
                  ref={inputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => void importFile(e.target.files?.[0])}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={importing}
                  onClick={() => inputRef.current?.click()}>
                  <Icon name="upload" className="h-3.5 w-3.5" />
                  {importing ? 'Importing…' : 'Import JSON'}
                </button>
              </>
            }
          />
        </FadeIn>

        {error && (
          <p role="alert" className="rounded border border-vermilion/40 bg-vermilion/[0.05] px-4 py-3 font-mono text-xs text-vermilion">
            {error}
          </p>
        )}

        <FadeIn delay={0.05}>
          {isPending ? (
            <p className="font-mono text-xs text-fg/40">Loading…</p>
          ) : isError ? (
            <p className="font-mono text-xs text-vermilion">Couldn't load imported sessions.</p>
          ) : sessions && sessions.length > 0 ? (
            <div className="border-y border-line/10">
              {sessions.map((s) => (
                <ReplayRow key={s.id} session={s} onDelete={remove} />
              ))}
            </div>
          ) : (
            <div className="rounded border border-dashed border-line/15 px-6 py-12 text-center">
              <Icon name="replay" className="mx-auto h-6 w-6 text-fg/30" />
              <p className="mt-3 text-sm text-fg/60">No imported sessions yet.</p>
              <p className="mt-1 text-xs text-fg/40">
                Export a session from its page or the Sessions list, then import the .json file here.
              </p>
            </div>
          )}
        </FadeIn>
      </div>
    </div>
  );
}

function ReplayRow({
  session: s,
  onDelete,
}: {
  session: SessionSummary;
  onDelete: (id: string) => Promise<void>;
}) {
  // Delete asks for a second click rather than a browser dialog, which the
  // desktop app's webview may not show.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirming]);

  return (
    <div className="group flex items-center gap-3 border-b border-line/10 px-3 py-2.5 transition-colors last:border-b-0 hover:bg-surface">
      <a
        href={sessionHref(s.id, 'replay')}
        className="flex min-w-0 flex-1 items-center gap-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vermilion">
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-fg">
          {s.title || `Session ${(s.imported_from ?? s.id).slice(0, 8)}`}
        </span>
        <SourceBadge source={s.source} />
        <span
          className="hidden font-mono text-[0.65rem] tabular-nums text-fg/40 sm:inline"
          title={`Original session ${s.imported_from}`}>
          from {s.imported_from?.slice(0, 8)}
        </span>
        <span className="inline-flex items-center gap-1 font-mono text-[0.65rem] tabular-nums text-fg/45">
          <Icon name="event" className="h-3 w-3" />
          {s.event_count}
        </span>
        <span className="w-28 shrink-0 text-right font-mono text-[0.65rem] text-fg/45" title="Recorded">
          {formatRelative(s.started_at)}
        </span>
        <span className="hidden w-28 shrink-0 text-right font-mono text-[0.65rem] text-fg/35 md:inline" title="Imported">
          imported {formatRelative(s.imported_at)}
        </span>
      </a>
      <a
        href={sessionExportUrl(s.id, 'replay')}
        download
        aria-label="Export session as JSON"
        title="Export as JSON"
        className="rounded p-1 text-fg/35 transition hover:bg-panel hover:text-fg focus-visible:outline-none">
        <Icon name="download" className="h-3.5 w-3.5" />
      </a>
      <button
        type="button"
        onClick={() => (confirming ? void onDelete(s.id) : setConfirming(true))}
        aria-label={confirming ? 'Confirm delete' : 'Delete imported session'}
        title={confirming ? 'Click again to delete' : 'Delete imported session'}
        className={`rounded p-1 font-mono text-[0.6rem] uppercase tracking-widest transition focus-visible:outline-none ${
          confirming ? 'bg-vermilion/10 px-2 text-vermilion' : 'text-fg/35 hover:bg-panel hover:text-fg'
        }`}>
        {confirming ? 'Delete?' : <Icon name="trash" className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
