const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en-US');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const dayTime = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export const fmt = {
  n: (v: number) => whole.format(Math.round(v)),
  k: (v: number) => compact.format(v),
  usd: (v: number) => usd.format(v),
  usd0: (v: number) => usd0.format(v),
  pct: (v: number) => pct.format(v),
  day: (iso: string) => day.format(new Date(iso)),
  dayTime: (iso: string) => dayTime.format(new Date(iso)),
  time: (iso: string) => time.format(new Date(iso)),
  dur(sec: number) {
    if (!isFinite(sec) || sec <= 0) return '0s';
    if (sec < 60) return `${Math.round(sec)}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ${Math.round(sec % 60)}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  },
  ms(ms: number | null) {
    if (ms == null) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  },
  /** Relative to the sample data's capture time, so "2h ago" stays true forever. */
  ago(iso: string, now: string) {
    const s = (new Date(now).getTime() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const d = Math.floor(s / 86400);
    return d < 30 ? `${d}d ago` : day.format(new Date(iso));
  },
  bytes(b: number) {
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(1)} GB`;
  },
};

export const project = (cwd: string | null) => cwd?.split('/').filter(Boolean).pop() ?? 'no project';
export const shortId = (id: string) => id.slice(0, 8);
export const modelLabel = (m: string) => {
  if (m.startsWith('gpt-')) return 'GPT-' + m.slice(4);
  const s = m.replace(/^claude-/, '').replace(/-(\d)/, ' $1').replace(/-(\d)/, '.$1');
  return s[0].toUpperCase() + s.slice(1);
};

/** Short event-kind labels, as in the demo (demo-variants/src/data/select.ts). */
export const CATEGORY_LABEL: Record<string, string> = {
  prompt: 'Prompt', response: 'Reply', thought: 'Thinking', shell: 'Shell', file_read: 'Read',
  file_edit: 'Edit', web: 'Web', mcp: 'MCP', lifecycle: 'Lifecycle', meta: 'Meta',
  context_read: 'Context', subagent: 'Subagent', permission: 'Permission', error: 'Error',
  question: 'Question', plan: 'Plan', compaction: 'Compaction', memory: 'Memory', notification: 'Notice', other: 'Other',
};
export const categoryLabel = (c: string) => CATEGORY_LABEL[c] ?? c[0].toUpperCase() + c.slice(1).replace(/_/g, ' ');
