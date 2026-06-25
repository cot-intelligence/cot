import { useEffect, useState } from 'react';
import {
  exportSessions,
  getSelfAudit,
  getMetrics,
  type ExportFilters,
  type ExportInclude,
} from '../../lib/api';
import { Icon } from '../ui/icons';

type ExportDataType = 'sessions' | 'audit' | 'metrics';
type ExportFormat = 'json' | 'csv';

interface ExportModalProps {
  onClose: () => void;
}

interface FieldDef {
  key: string;
  label: string;
}

const SESSION_FIELDS: FieldDef[] = [
  { key: 'id', label: 'ID' },
  { key: 'source', label: 'Source' },
  { key: 'status', label: 'Status' },
  { key: 'title', label: 'Title' },
  { key: 'cwd', label: 'Directory' },
  { key: 'models', label: 'Models' },
  { key: 'started_at', label: 'Started' },
  { key: 'ended_at', label: 'Ended' },
  { key: 'event_count', label: 'Events' },
  { key: 'tool_count', label: 'Tools' },
  { key: 'duration_seconds', label: 'Duration' },
  { key: 'cost_usd', label: 'Cost' },
  { key: 'tokens.input', label: 'In tokens' },
  { key: 'tokens.output', label: 'Out tokens' },
  { key: 'tokens.cache_read', label: 'Cache R' },
  { key: 'tokens.cache_write', label: 'Cache W' },
  { key: 'tokens.total', label: 'Total tok' },
];

const AUDIT_FIELDS: FieldDef[] = [
  { key: 'id', label: 'ID' },
  { key: 'action', label: 'Action' },
  { key: 'actor', label: 'Actor' },
  { key: 'target', label: 'Target' },
  { key: 'status', label: 'Status' },
  { key: 'ts', label: 'Timestamp' },
];

const DATA_TYPES: { key: ExportDataType; label: string }[] = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'audit', label: 'Audit' },
  { key: 'metrics', label: 'Metrics' },
];

const FIELD_MAP: Record<ExportDataType, FieldDef[]> = {
  sessions: SESSION_FIELDS,
  audit: AUDIT_FIELDS,
  metrics: [],
};

interface IncludeDef {
  key: ExportInclude;
  label: string;
  hint: string;
}

const INCLUDE_OPTIONS: IncludeDef[] = [
  { key: 'events', label: 'Events', hint: 'Full timeline of every tool call, prompt, and response' },
  { key: 'components', label: 'Components', hint: 'Files edited/read, shell commands, MCP calls, subagents' },
  { key: 'conversation', label: 'Conversation', hint: 'Structured prompt/response thread with roles' },
  { key: 'clarifications', label: 'Clarifications', hint: 'Questions the agent asked and user answers' },
];

const SOURCE_OPTIONS = ['claude', 'cursor', 'codex'] as const;

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

function toCsv(rows: Record<string, unknown>[], fields: string[]): string {
  const escape = (v: unknown): string => {
    if (v == null) return '';
    const str = Array.isArray(v) ? v.join('; ') : String(v);
    if (str.includes(',') || str.includes('"') || str.includes('\n'))
      return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  const header = fields.map(escape).join(',');
  const lines = rows.map((row) =>
    fields.map((f) => escape(getNestedValue(row, f))).join(','),
  );
  return [header, ...lines].join('\n');
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ExportModal({ onClose }: ExportModalProps) {
  const [dataType, setDataType] = useState<ExportDataType>('sessions');
  const [format, setFormat] = useState<ExportFormat>('json');
  const [selectedFields, setSelectedFields] = useState<Set<string>>(
    () => new Set(SESSION_FIELDS.map((f) => f.key)),
  );
  const [includeSections, setIncludeSections] = useState<Set<ExportInclude>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [sessionIds, setSessionIds] = useState('');
  const [source, setSource] = useState('');
  const [cwd, setCwd] = useState('');
  const [models, setModels] = useState('');
  const [startedAfter, setStartedAfter] = useState('');
  const [startedBefore, setStartedBefore] = useState('');
  const [endedAfter, setEndedAfter] = useState('');
  const [endedBefore, setEndedBefore] = useState('');
  const [sessionStatus, setSessionStatus] = useState('');
  const [minTokens, setMinTokens] = useState('');
  const [minCost, setMinCost] = useState('');
  const [minEvents, setMinEvents] = useState('');

  const fields = FIELD_MAP[dataType];
  const hasFields = fields.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleDataTypeChange = (type: ExportDataType) => {
    setDataType(type);
    setHint(null);
    setSelectedFields(new Set(FIELD_MAP[type].map((f) => f.key)));
    if (type === 'metrics' && format === 'csv') setFormat('json');
    if (type !== 'sessions') {
      setFiltersOpen(false);
      setIncludeSections(new Set());
    }
  };

  const toggleField = (key: string) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleInclude = (key: ExportInclude) => {
    setIncludeSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (format === 'csv' && !includeSections.has(key)) setFormat('json');
  };

  const activeFilterCount = [
    sessionIds, source, cwd, models,
    startedAfter, startedBefore, endedAfter, endedBefore,
    sessionStatus, minTokens, minCost, minEvents,
  ].filter(Boolean).length;

  const clearFilters = () => {
    setSessionIds(''); setSource(''); setCwd(''); setModels('');
    setStartedAfter(''); setStartedBefore(''); setEndedAfter(''); setEndedBefore('');
    setSessionStatus(''); setMinTokens(''); setMinCost(''); setMinEvents('');
  };

  const handleExport = async () => {
    if (hasFields && selectedFields.size === 0) return;
    setExporting(true);
    setHint(null);
    try {
      const ts = new Date().toISOString().slice(0, 10);
      const selected = Array.from(selectedFields);
      let content: string;
      let filename: string;

      if (dataType === 'sessions') {
        const filters: ExportFilters = { fields: selected };
        if (includeSections.size > 0)
          filters.include = Array.from(includeSections);
        if (sessionIds.trim())
          filters.session_ids = sessionIds.split(',').map((s) => s.trim()).filter(Boolean);
        if (source) filters.source = source;
        if (cwd.trim()) filters.cwd = cwd.trim();
        if (models.trim())
          filters.models = models.split(',').map((s) => s.trim()).filter(Boolean);
        if (startedAfter) filters.started_after = new Date(startedAfter).toISOString();
        if (startedBefore) filters.started_before = new Date(startedBefore).toISOString();
        if (endedAfter) filters.ended_after = new Date(endedAfter).toISOString();
        if (endedBefore) filters.ended_before = new Date(endedBefore).toISOString();
        if (sessionStatus) filters.status = sessionStatus;
        if (minTokens) filters.min_tokens = Number(minTokens);
        if (minCost) filters.min_cost = Number(minCost);
        if (minEvents) filters.min_events = Number(minEvents);

        const result = await exportSessions(filters);
        const rows = result.sessions;
        if (format === 'csv') {
          content = toCsv(rows, selected);
          filename = `cot-sessions-${ts}.csv`;
        } else {
          content = JSON.stringify(rows, null, 2);
          filename = `cot-sessions-${ts}.json`;
        }
        setHint(`Exported ${result.count} session${result.count !== 1 ? 's' : ''} to ${filename}`);
      } else if (dataType === 'audit') {
        const raw = await getSelfAudit(10000);
        const rows = raw as unknown as Record<string, unknown>[];
        if (format === 'csv') {
          content = toCsv(rows, selected);
          filename = `cot-audit-${ts}.csv`;
        } else {
          const picked = rows.map((r) => {
            const out: Record<string, unknown> = {};
            for (const f of selected) out[f] = (r as Record<string, unknown>)[f];
            return out;
          });
          content = JSON.stringify(picked, null, 2);
          filename = `cot-audit-${ts}.json`;
        }
        setHint(`Exported ${rows.length} audit event${rows.length !== 1 ? 's' : ''} to ${filename}`);
      } else {
        const metrics = await getMetrics();
        content = JSON.stringify(metrics, null, 2);
        filename = `cot-metrics-${ts}.json`;
        setHint(`Exported metrics snapshot to ${filename}`);
      }

      downloadFile(content, filename, format === 'csv' ? 'text/csv' : 'application/json');
    } catch (e) {
      setHint(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const allSelected = hasFields && selectedFields.size === fields.length;
  const noneSelected = hasFields && selectedFields.size === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 px-4 py-8 backdrop-blur-sm"
      onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Export data"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden border border-fg/15 bg-bg shadow-soft-lg">

        {/* ── Header ── */}
        <div className="flex items-center justify-between border-b border-fg/10 px-5 py-3.5">
          <h2 className="font-serif text-xl font-bold uppercase tracking-tight text-fg">
            Export your <span className="lowercase italic text-cobalt">data</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center border border-fg/20 font-mono text-sm text-fg/60 transition-colors hover:border-fg/50 hover:text-fg">
            ✕
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="scroll-thin flex-1 space-y-5 overflow-y-auto p-5">

          {/* Row 1: Data + Format side by side */}
          <div className="flex gap-5">
            <div className="flex-1 space-y-1.5">
              <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
                Data
              </span>
              <div className="grid grid-cols-3 gap-px bg-fg/15">
                {DATA_TYPES.map((dt) => (
                  <button
                    key={dt.key}
                    type="button"
                    onClick={() => handleDataTypeChange(dt.key)}
                    className={`py-2 font-mono text-[0.6rem] font-bold uppercase tracking-widest transition-colors ${
                      dataType === dt.key
                        ? 'bg-fg text-bg'
                        : 'bg-bg text-fg/55 hover:text-fg'
                    }`}>
                    {dt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="w-36 shrink-0 space-y-1.5">
              <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
                Format
              </span>
              <div className="grid grid-cols-2 gap-px bg-fg/15">
                {(['json', 'csv'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFormat(f)}
                    disabled={(f === 'csv' && dataType === 'metrics') || (f === 'csv' && includeSections.size > 0)}
                    className={`py-2 font-mono text-[0.6rem] font-bold uppercase tracking-widest transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                      format === f
                        ? 'bg-fg text-bg'
                        : 'bg-bg text-fg/55 hover:text-fg'
                    }`}>
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Row 2: Fields */}
          {hasFields ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
                  Fields{includeSections.size > 0 && (
                    <span className="ml-1.5 font-normal text-fg/25">summary</span>
                  )}
                </span>
                <div className="flex items-baseline gap-3">
                  <button
                    type="button"
                    onClick={() => setSelectedFields(new Set(fields.map((f) => f.key)))}
                    disabled={allSelected}
                    className="font-mono text-[0.55rem] uppercase tracking-widest text-cobalt transition-colors hover:text-cobalt/80 disabled:text-fg/20">
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedFields(new Set())}
                    disabled={noneSelected}
                    className="font-mono text-[0.55rem] uppercase tracking-widest text-cobalt transition-colors hover:text-cobalt/80 disabled:text-fg/20">
                    None
                  </button>
                  <span className="font-mono text-[0.55rem] tabular-nums text-fg/30">
                    {selectedFields.size}/{fields.length}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {fields.map((f) => {
                  const on = selectedFields.has(f.key);
                  return (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => toggleField(f.key)}
                      aria-pressed={on}
                      className={`border px-2 py-1 font-mono text-[0.58rem] uppercase tracking-wider transition-colors ${
                        on
                          ? 'border-cobalt bg-cobalt/10 text-cobalt'
                          : 'border-fg/15 text-fg/40 hover:border-fg/35 hover:text-fg/70'
                      }`}>
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
                Fields
              </span>
              <p className="font-mono text-[0.55rem] text-fg/35">
                Full snapshot — all fields included.
              </p>
            </div>
          )}

          {/* Row 3: Include (sessions only) */}
          {dataType === 'sessions' && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
                  Include
                </span>
                {includeSections.size > 0 && (
                  <span className="font-mono text-[0.55rem] tabular-nums text-cobalt">
                    {includeSections.size} section{includeSections.size !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {INCLUDE_OPTIONS.map((opt) => {
                  const on = includeSections.has(opt.key);
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => toggleInclude(opt.key)}
                      aria-pressed={on}
                      className={`flex flex-col items-start border px-3 py-2 text-left transition-colors ${
                        on
                          ? 'border-cobalt bg-cobalt/10'
                          : 'border-fg/15 hover:border-fg/35'
                      }`}>
                      <span className={`font-mono text-[0.6rem] font-bold uppercase tracking-wider ${
                        on ? 'text-cobalt' : 'text-fg/55'
                      }`}>
                        {opt.label}
                      </span>
                      <span className="font-mono text-[0.5rem] leading-snug text-fg/35">
                        {opt.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
              {includeSections.size > 0 && format === 'csv' && (
                <p className="font-mono text-[0.5rem] text-amber-500">
                  Nested data requires JSON — format switched automatically.
                </p>
              )}
            </div>
          )}

          {/* Row 4: Filters (collapsible, sessions only) */}
          {dataType === 'sessions' && (
            <div className="border border-fg/10">
              <button
                type="button"
                onClick={() => setFiltersOpen(!filtersOpen)}
                className="flex w-full items-center justify-between px-4 py-2.5 transition-colors hover:bg-surface/50">
                <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/45">
                  Filters{' '}
                  {activeFilterCount > 0 && (
                    <span className="text-cobalt">· {activeFilterCount} active</span>
                  )}
                </span>
                <Icon
                  name={filtersOpen ? 'chevron-up' : 'chevron-down'}
                  className="h-3.5 w-3.5 text-fg/35"
                />
              </button>

              {filtersOpen && (
                <div className="border-t border-fg/10 bg-panel/30 px-4 pb-4 pt-3">
                  <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2 md:grid-cols-3">
                    <InputField label="Session IDs" hint="comma-sep" value={sessionIds} onChange={setSessionIds} />
                    <SelectField label="Source" value={source} onChange={setSource} options={SOURCE_OPTIONS} />
                    <InputField label="Repository" hint="match cwd" value={cwd} onChange={setCwd} />
                    <InputField label="Models" hint="comma-sep" value={models} onChange={setModels} />
                    <SelectField label="Status" value={sessionStatus} onChange={setSessionStatus} options={['active', 'completed']} />
                    <InputField label="Min tokens" value={minTokens} onChange={setMinTokens} type="number" />
                    <InputField label="Started after" value={startedAfter} onChange={setStartedAfter} type="datetime-local" />
                    <InputField label="Started before" value={startedBefore} onChange={setStartedBefore} type="datetime-local" />
                    <InputField label="Min cost ($)" value={minCost} onChange={setMinCost} type="number" step="0.01" />
                    <InputField label="Ended after" value={endedAfter} onChange={setEndedAfter} type="datetime-local" />
                    <InputField label="Ended before" value={endedBefore} onChange={setEndedBefore} type="datetime-local" />
                    <InputField label="Min events" value={minEvents} onChange={setMinEvents} type="number" />
                  </div>
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="mt-3 font-mono text-[0.55rem] uppercase tracking-widest text-vermilion transition-colors hover:text-vermilion/80">
                      Reset all filters
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="border-t border-fg/10 px-5 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <p className="min-h-[1rem] flex-1 font-mono text-[0.6rem] text-fg/45">
              {hint ?? (dataType === 'metrics'
                ? 'Full metrics snapshot, aggregated across all sessions.'
                : dataType === 'audit'
                  ? 'All configuration audit events will be exported.'
                  : includeSections.size > 0
                    ? `Full export with ${Array.from(includeSections).join(', ')}. Use filters to narrow.`
                    : 'All sessions will be exported. Use filters to narrow.')}
            </p>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={onClose}
                className="border border-fg/20 px-3 py-2 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-fg/60 transition-colors hover:border-fg/45 hover:text-fg">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting || (hasFields && noneSelected)}
                className="flex items-center gap-2 border border-cobalt bg-cobalt px-4 py-2 font-mono text-[0.62rem] font-bold uppercase tracking-widest text-cream transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
                {exporting ? (
                  'Exporting…'
                ) : (
                  <>
                    <Icon name="unarchive" className="h-3.5 w-3.5" />
                    Export {format.toUpperCase()}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InputField({
  label,
  hint,
  value,
  onChange,
  type = 'text',
  step,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  step?: string;
}) {
  return (
    <label className="space-y-0.5">
      <span className="font-mono text-[0.5rem] font-bold uppercase tracking-widest text-fg/40">
        {label}
        {hint && <span className="ml-1 font-normal text-fg/25">{hint}</span>}
      </span>
      <input
        type={type}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full border border-fg/15 bg-surface px-2 py-1.5 font-mono text-[0.7rem] text-fg placeholder:text-fg/25 focus:border-cobalt focus:outline-none"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="space-y-0.5">
      <span className="font-mono text-[0.5rem] font-bold uppercase tracking-widest text-fg/40">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full border border-fg/15 bg-surface px-2 py-1.5 font-mono text-[0.7rem] text-fg focus:border-cobalt focus:outline-none">
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
