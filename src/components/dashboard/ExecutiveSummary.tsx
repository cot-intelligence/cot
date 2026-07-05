import type {
  ActionableInsight,
  AiAnalysis,
  InsightPillar,
  InsightsResponse,
  Metrics,
} from '../../lib/api';
import { formatRelative } from '../../lib/categoryMeta';
import { SeverityBadge } from './insightStrip';
import { Icon } from '../ui/icons';

const PILLAR_LABELS: Record<InsightPillar, string> = {
  usability: 'Usability',
  cost: 'Cost',
  security: 'Security',
};

const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 } as const;

/** Top issues across all sessions: severity-first, one finding per rule, capped. */
function topIssues(findings: ActionableInsight[], cap = 4): ActionableInsight[] {
  const seen = new Set<string>();
  return [...findings]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .filter((f) => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    })
    .slice(0, cap);
}

export function ExecutiveSummary({
  insights,
  metrics,
  aiAnalysis,
  onJump,
}: {
  insights: InsightsResponse | null;
  metrics: Metrics;
  aiAnalysis: AiAnalysis | null;
  onJump: (pillar: InsightPillar) => void;
}) {
  if (!insights) {
    return <p className="font-mono text-xs text-fg/40">Computing findings…</p>;
  }
  const active = insights.insights.filter((f) => f.status === 'active');
  const criticals = active.filter((f) => f.severity === 'critical').length;
  const warns = active.filter((f) => f.severity === 'warn').length;
  const issues = topIssues(active);
  const sessions = metrics.totals.sessions;

  return (
    <div className="border border-fg/15 bg-panel/40">
      {aiAnalysis?.result?.summary && (
        <div className="border-b border-fg/10 px-4 py-3.5">
          <p className="font-serif text-sm italic leading-relaxed text-fg/85">
            {aiAnalysis.result.summary}
          </p>
          <p className="mt-1.5 font-mono text-[0.55rem] uppercase tracking-widest text-fg/40">
            AI · {aiAnalysis.provider}/{aiAnalysis.model} · {formatRelative(aiAnalysis.created_at)}
          </p>
        </div>
      )}
      <div className="px-4 py-3.5">
        {active.length ? (
          <p className="font-mono text-xs font-bold text-fg">
            {active.length} active {active.length === 1 ? 'finding' : 'findings'} across{' '}
            {sessions} {sessions === 1 ? 'session' : 'sessions'}
            <span className="font-normal text-fg/55">
              {' — '}
              {criticals ? <span className="font-bold text-vermilion">{criticals} critical</span> : null}
              {criticals && warns ? ', ' : null}
              {warns ? `${warns} warn` : null}
              {!criticals && !warns ? 'informational only' : null}
            </span>
          </p>
        ) : (
          <p className="font-mono text-xs font-bold text-olive">
            All clear — no active findings across {sessions}{' '}
            {sessions === 1 ? 'session' : 'sessions'}.
          </p>
        )}
        {issues.length > 0 && (
          <ul className="mt-3 divide-y divide-fg/10">
            {issues.map((f) => (
              <li key={f.fingerprint}>
                <button
                  type="button"
                  onClick={() => onJump(f.pillar)}
                  title={`Jump to ${PILLAR_LABELS[f.pillar]} insights`}
                  className="group flex w-full items-start gap-2.5 py-2 text-left">
                  <SeverityBadge severity={f.severity} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs font-bold text-fg transition-colors group-hover:text-vermilion">
                      {f.title}
                    </span>
                    <span className="block truncate font-mono text-[0.62rem] text-fg/55">
                      {f.recommendation}
                    </span>
                  </span>
                  <span className="hidden shrink-0 items-center gap-1.5 font-mono text-[0.55rem] uppercase tracking-widest text-fg/35 sm:flex">
                    {PILLAR_LABELS[f.pillar]}
                    <Icon
                      name="chevron-right"
                      className="h-2.5 w-2.5 transition-colors group-hover:text-vermilion"
                    />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
