import { useState } from 'react';
import {
  runAiAnalysis,
  type AiAnalysis,
  type AiAnalysisResult,
  type AiInsightItem,
  type Settings,
} from '../../lib/api';
import { formatRelative } from '../../lib/categoryMeta';
import { Icon } from '../ui/icons';
import { SeverityBadge } from './insightStrip';

const SECTION_LABELS: { key: keyof AiAnalysisResult['sections']; label: string }[] = [
  { key: 'usage', label: 'Usage' },
  { key: 'security', label: 'Security' },
  { key: 'cost', label: 'Cost' },
];

function AiItemCard({ item }: { item: AiInsightItem }) {
  return (
    <div className="min-w-0 bg-bg px-4 py-3">
      <div className="flex items-start gap-2.5">
        <SeverityBadge severity={item.severity} />
        <p className="min-w-0 flex-1 font-mono text-xs font-bold text-fg">{item.title}</p>
      </div>
      <div className="mt-2 space-y-2 pl-0.5">
        <p className="break-words font-mono text-[0.68rem] leading-relaxed text-fg/70">
          {item.detail}
        </p>
        {item.recommendation && (
          <p className="border-l-[3px] border-cobalt pl-2.5 font-mono text-[0.68rem] font-bold leading-relaxed text-fg/85">
            {item.recommendation}
          </p>
        )}
      </div>
    </div>
  );
}

function AnalysisResult({ analysis }: { analysis: AiAnalysis }) {
  if (!analysis.result) return null;
  return (
    <div className="space-y-4">
      <p className="font-serif text-sm italic leading-relaxed text-fg/85">
        {analysis.result.summary}
      </p>
      {SECTION_LABELS.map(({ key, label }) => {
        const items = analysis.result!.sections[key] ?? [];
        if (!items.length) return null;
        return (
          <div key={key} className="space-y-2">
            <p className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
              {label}
            </p>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-px bg-fg/10">
              {items.map((item, i) => (
                <AiItemCard key={`${key}-${i}`} item={item} />
              ))}
            </div>
          </div>
        );
      })}
      <p className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/35">
        {analysis.provider}/{analysis.model} · {formatRelative(analysis.created_at)} ·{' '}
        {analysis.window_days === 0 ? 'all time' : `last ${analysis.window_days}d`}
      </p>
    </div>
  );
}

export function AiInsightsSection({
  days,
  settings,
  analyses,
  onRan,
}: {
  days: number;
  settings: Settings | null;
  analyses: AiAnalysis[];
  onRan: (analysis: AiAnalysis) => void;
}) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const latest = analyses.find((a) => a.status === 'ok' && a.result) ?? null;
  const configured = settings?.ai_configured ?? false;
  const envDisabled = settings?.ai_env_disabled ?? false;
  const disabledHint = envDisabled
    ? 'Disabled by COT_DISABLE_LLM'
    : !configured
      ? 'Add an API key in Settings'
      : null;

  const run = async () => {
    setRunning(true);
    setRunError(null);
    try {
      onRan(await runAiAnalysis(days));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={running || !configured || envDisabled}
          title={disabledHint ?? 'Send masked aggregates to your provider for analysis'}
          className="flex shrink-0 items-center gap-2 border border-fg/25 px-3 py-2 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-fg/75 shadow-brutal-sm transition-colors enabled:hover:border-vermilion enabled:hover:text-vermilion disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-vermilion focus-visible:outline-none">
          <Icon name="brain" className="h-3.5 w-3.5" />
          {running ? 'Analyzing… (can take a minute)' : 'Run analysis'}
        </button>
        {disabledHint && (
          <span className="font-mono text-[0.62rem] text-fg/45">
            {disabledHint}
            {!envDisabled && (
              <>
                {' — '}
                <a href="#/settings" className="underline transition-colors hover:text-vermilion">
                  open Settings
                </a>
              </>
            )}
          </span>
        )}
        {configured && !envDisabled && !running && (
          <span className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/35">
            Uses your {settings?.ai_provider} key · secret-masked before sending · never automatic
          </span>
        )}
      </div>

      {runError && (
        <p className="border-l-[3px] border-vermilion pl-2.5 font-mono text-[0.68rem] leading-relaxed text-vermilion">
          {runError}
        </p>
      )}

      {latest ? (
        <AnalysisResult analysis={latest} />
      ) : (
        !running &&
        configured && (
          <p className="font-mono text-xs text-fg/40">
            No analysis yet — run one to get AI insights on usage, security, and cost.
          </p>
        )
      )}

      {analyses.length > (latest ? 1 : 0) && (
        <div>
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            className="flex items-center gap-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-fg/45 transition-colors hover:text-fg">
            <Icon name={historyOpen ? 'chevron-down' : 'chevron-right'} className="h-3 w-3" />
            Previous analyses ({analyses.length})
          </button>
          {historyOpen && (
            <ul className="mt-2 divide-y divide-fg/10 border border-fg/10">
              {analyses.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
                    <span
                      className={`shrink-0 border px-1.5 py-0.5 font-mono text-[0.5rem] font-bold uppercase tracking-widest ${
                        a.status === 'ok' ? 'border-olive/60 text-olive' : 'border-vermilion/60 text-vermilion'
                      }`}>
                      {a.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[0.62rem] text-fg/65">
                      {a.provider}/{a.model} ·{' '}
                      {a.window_days === 0 ? 'all time' : `${a.window_days}d`}
                    </span>
                    <span className="shrink-0 font-mono text-[0.55rem] text-fg/35">
                      {formatRelative(a.created_at)}
                    </span>
                  </button>
                  {expandedId === a.id && (
                    <div className="border-t border-fg/10 px-3 py-3">
                      {a.status === 'ok' ? (
                        <AnalysisResult analysis={a} />
                      ) : (
                        <p className="break-words font-mono text-[0.68rem] text-vermilion">
                          {a.error ?? 'Analysis failed.'}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
