import { useEffect, useMemo, useRef, useState } from 'react';
import type { Metrics } from '../../lib/api';
import {
  buildChartSeries,
  buildShareText,
  buildStats,
  CARD_H,
  CARD_W,
  copyCanvasImage,
  copyCanvasSharePayload,
  type CardTheme,
  type ChartSeries,
  DEFAULT_KEYS,
  drawShareCard,
  MAX_STATS,
  type ShareStat,
} from '../../lib/shareCard';
import { Icon } from '../ui/icons';

interface ShareCardModalProps {
  metrics: Metrics;
  onClose: () => void;
}

type Action = 'download' | 'copy' | 'x' | 'linkedin';

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function ShareCardModal({ metrics, onClose }: ShareCardModalProps) {
  const allStats = useMemo(() => buildStats(metrics), [metrics]);
  const [selected, setSelected] = useState<string[]>(() => {
    const present = DEFAULT_KEYS.filter((k) => allStats.some((s) => s.key === k));
    return (present.length ? present : allStats.map((s) => s.key)).slice(0, MAX_STATS);
  });
  const [title, setTitle] = useState('My coding footprint');
  const [handle, setHandle] = useState('');
  const [theme, setTheme] = useState<CardTheme>('light');
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);

  // Chartable series, split into the line pool (sequential) and the
  // distribution pool (bars / pie).
  const charts = useMemo(() => buildChartSeries(metrics), [metrics]);
  const [lineKey, setLineKey] = useState(() => charts.line[0]?.key ?? '');
  const [distKey, setDistKey] = useState(
    () => (charts.dist.find((d) => d.key === 'pie:models') ?? charts.dist[0])?.key ?? '',
  );
  const lineSeries: ChartSeries = useMemo(
    () =>
      charts.line.find((s) => s.key === lineKey) ??
      charts.line[0] ?? { key: '', label: 'Activity', kind: 'line', data: [0, 0] },
    [charts, lineKey],
  );
  const distSeries: ChartSeries = useMemo(
    () =>
      charts.dist.find((s) => s.key === distKey) ??
      charts.dist[0] ?? { key: '', label: 'Breakdown', kind: 'bars', data: [0] },
    [charts, distKey],
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Selected stats, in menu order, capped to what the card can show.
  const chosen: ShareStat[] = useMemo(
    () => allStats.filter((s) => selected.includes(s.key)).slice(0, MAX_STATS),
    [allStats, selected],
  );

  const options = useMemo(
    () => ({ title, handle, theme, stats: chosen, lineSeries, distSeries }),
    [title, handle, theme, chosen, lineSeries, distSeries],
  );

  // Redraw the preview whenever the card inputs change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawShareCard(canvas, options).catch(() => {});
  }, [options]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (key: string) => {
    setHint(null);
    setSelected((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= MAX_STATS) {
        setHint(`Pick up to ${MAX_STATS} metrics — deselect one first.`);
        return prev;
      }
      return [...prev, key];
    });
  };

  const downloadImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob = await canvasToBlob(canvas);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cot-metrics.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const copyImage = async (): Promise<boolean> => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    return copyCanvasImage(canvas);
  };

  const run = async (action: Action) => {
    setBusy(action);
    try {
      if (action === 'download') {
        await downloadImage();
        setHint('Card saved as cot-metrics.png.');
      } else if (action === 'copy') {
        const ok = await copyImage();
        setHint(ok ? 'Card copied — paste (⌘V) anywhere.' : 'Clipboard blocked — saving instead.');
        if (!ok) await downloadImage();
      } else {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const text = buildShareText(options, action);
        const copied =
          action === 'x'
            ? await copyCanvasImage(canvas)
            : await copyCanvasSharePayload(canvas, text);

        const composeUrl =
          action === 'x'
            ? `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`
            : 'https://www.linkedin.com/feed/?shareActive=true';
        window.open(composeUrl, '_blank', 'noopener,noreferrer');

        if (!copied) await downloadImage();

        setHint(
          copied
            ? action === 'x'
              ? 'Card copied — paste (⌘V) into the X compose tab (caption is already filled in).'
              : 'Card copied — paste (⌘V) into the LinkedIn compose tab.'
            : action === 'x'
              ? 'X compose opened — attach cot-metrics.png from Downloads.'
              : 'LinkedIn compose opened — attach cot-metrics.png from Downloads.',
        );
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4 py-8 backdrop-blur-sm"
      onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share your metrics"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden border border-fg/15 bg-bg shadow-soft-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-fg/10 px-5 py-3.5">
          <div className="flex items-baseline gap-2">
            <h2 className="font-serif text-xl font-bold uppercase tracking-tight text-fg">
              Share your <span className="lowercase italic text-vermilion">card</span>
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center border border-fg/20 font-mono text-sm text-fg/60 transition-colors hover:border-fg/50 hover:text-fg">
            ✕
          </button>
        </div>

        <div className="scroll-thin flex flex-col gap-6 overflow-y-auto p-5 md:flex-row">
          {/* Controls */}
          <div className="w-full shrink-0 space-y-5 md:w-64">
            <div className="space-y-1.5">
              <label className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
                Headline
              </label>
              <input
                value={title}
                maxLength={32}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="My coding footprint"
                className="w-full border border-fg/20 bg-surface px-2.5 py-2 font-mono text-xs text-fg placeholder:text-fg/30 focus:border-vermilion focus:outline-none"
              />
              <p className="font-mono text-[0.5rem] text-fg/35">Last word becomes the accent.</p>
            </div>

            <div className="space-y-1.5">
              <label className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
                Handle <span className="text-fg/25">(optional)</span>
              </label>
              <input
                value={handle}
                maxLength={24}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="@you"
                className="w-full border border-fg/20 bg-surface px-2.5 py-2 font-mono text-xs text-fg placeholder:text-fg/30 focus:border-vermilion focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
                Theme
              </span>
              <div className="grid grid-cols-2 gap-px bg-fg/15">
                {(['light', 'dark'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTheme(t)}
                    className={`py-2 font-mono text-[0.6rem] font-bold uppercase tracking-widest transition-colors ${
                      theme === t ? 'bg-fg text-bg' : 'bg-bg text-fg/55 hover:text-fg'
                    }`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
                  Metrics
                </span>
                <span className="font-mono text-[0.55rem] tabular-nums text-fg/35">
                  {selected.length}/{MAX_STATS}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {allStats.map((s) => {
                  const on = selected.includes(s.key);
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => toggle(s.key)}
                      aria-pressed={on}
                      className={`border px-2 py-1 font-mono text-[0.58rem] uppercase tracking-wider transition-colors ${
                        on
                          ? 'border-vermilion bg-vermilion/10 text-vermilion'
                          : 'border-fg/20 text-fg/55 hover:border-fg/45 hover:text-fg'
                      }`}>
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {charts.line.length > 0 && (
              <SeriesPicker
                label="Line chart"
                options={charts.line}
                value={lineSeries.key}
                onChange={setLineKey}
              />
            )}
            {charts.dist.length > 0 && (
              <SeriesPicker
                label="Distribution"
                options={charts.dist}
                value={distSeries.key}
                onChange={setDistKey}
              />
            )}
          </div>

          {/* Preview + actions */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="border border-fg/15 bg-panel/40 p-3">
              <canvas
                ref={canvasRef}
                style={{ aspectRatio: `${CARD_W} / ${CARD_H}` }}
                className="block w-full"
              />
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <ActionButton
                label="X"
                busy={busy === 'x'}
                onClick={() => run('x')}
                icon={<XLogo />}
              />
              <ActionButton
                label="LinkedIn"
                busy={busy === 'linkedin'}
                onClick={() => run('linkedin')}
                icon={<LinkedInLogo />}
              />
              <ActionButton
                label="Copy"
                busy={busy === 'copy'}
                onClick={() => run('copy')}
                icon={<Icon name="layers" className="h-4 w-4" />}
              />
              <ActionButton
                label="Download"
                busy={busy === 'download'}
                onClick={() => run('download')}
                icon={<Icon name="unarchive" className="h-4 w-4" />}
              />
            </div>

            <p className="min-h-[1rem] font-mono text-[0.6rem] text-fg/45">
              {hint ??
                'Copy or share copies the card image — paste (⌘V) into X or LinkedIn compose.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SeriesPicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ChartSeries[];
  value: string;
  onChange: (key: string) => void;
}) {
  const kindTag = (k: ChartSeries['kind']) => (k === 'line' ? 'line' : k === 'pie' ? 'pie' : 'bars');
  return (
    <div className="space-y-2">
      <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = o.key === value;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => onChange(o.key)}
              aria-pressed={on}
              className={`flex items-center gap-1.5 border px-2 py-1 font-mono text-[0.58rem] uppercase tracking-wider transition-colors ${
                on
                  ? 'border-vermilion bg-vermilion/10 text-vermilion'
                  : 'border-fg/20 text-fg/55 hover:border-fg/45 hover:text-fg'
              }`}>
              {o.label}
              <span className={`text-[0.5rem] ${on ? 'text-vermilion/70' : 'text-fg/30'}`}>
                {kindTag(o.kind)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  icon,
  onClick,
  busy,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex items-center justify-center gap-2 border border-fg/25 px-3 py-2.5 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-fg/75 transition-colors hover:border-fg/55 hover:text-fg disabled:opacity-60">
      {busy ? <span className="font-mono">…</span> : icon}
      {label}
    </button>
  );
}

function XLogo() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function LinkedInLogo() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}
