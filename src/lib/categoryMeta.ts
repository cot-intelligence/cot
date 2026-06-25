import type { EventCategory } from './api';

export interface CategoryMeta {
  label: string;
  color: string;
  dot: string;
}

// Calm palette: most categories are neutral (fg at stepped opacity).
// vermilion = edits / permissions (focal), cobalt = external (mcp / web),
// olive = memory (persistence). This avoids a rainbow across lists/timeline.
export const CATEGORY_META: Record<string, CategoryMeta> = {
  prompt: { label: 'Prompt', color: 'text-fg', dot: 'bg-fg' },
  question: { label: 'Prompt', color: 'text-fg', dot: 'bg-fg' },
  response: { label: 'Response', color: 'text-fg/75', dot: 'bg-fg/65' },
  thought: { label: 'Thought', color: 'text-fg/55', dot: 'bg-fg/45' },
  plan: { label: 'Plan', color: 'text-olive', dot: 'bg-olive' },
  file_edit: { label: 'File edit', color: 'text-vermilion', dot: 'bg-vermilion' },
  file_read: { label: 'File read', color: 'text-fg/65', dot: 'bg-fg/50' },
  context_read: { label: 'Context / skill', color: 'text-fg/65', dot: 'bg-fg/50' },
  shell: { label: 'Shell', color: 'text-fg/70', dot: 'bg-fg/55' },
  mcp: { label: 'MCP / plugin', color: 'text-cobalt', dot: 'bg-cobalt' },
  web: { label: 'External network', color: 'text-cobalt', dot: 'bg-cobalt' },
  subagent: { label: 'Subagent', color: 'text-fg/70', dot: 'bg-fg/55' },
  memory: { label: 'Memory', color: 'text-olive', dot: 'bg-olive' },
  compaction: { label: 'Compaction', color: 'text-fg/50', dot: 'bg-fg/35' },
  permission: { label: 'Permission', color: 'text-vermilion', dot: 'bg-vermilion' },
  notification: { label: 'Notification', color: 'text-fg/50', dot: 'bg-fg/35' },
  lifecycle: { label: 'Lifecycle', color: 'text-fg/45', dot: 'bg-fg/30' },
  meta: { label: 'Workflow / meta', color: 'text-fg/45', dot: 'bg-fg/30' },
  other: { label: 'Other', color: 'text-fg/45', dot: 'bg-fg/30' },
};

export function getCategoryMeta(cat: string): CategoryMeta {
  return CATEGORY_META[cat] ?? CATEGORY_META.other;
}

export const ALL_CATEGORIES = Object.keys(CATEGORY_META) as EventCategory[];

/** Coerce API timestamps (ISO string or legacy epoch number) to an ISO string. */
export function toTimestampString(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e11 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  return String(value);
}

export function formatRelative(value: string | number | null | undefined): string {
  const iso = toTimestampString(value);
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleDateString([], { timeZone: userTimeZone() });
}

export function formatTime(value: string | number | null | undefined): string {
  const iso = toTimestampString(value);
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: userTimeZone(),
    timeZoneName: 'short',
  });
}

/**
 * Compact timestamp for dense lists: month-day + HH:MM, no seconds, year, or
 * timezone. Keeps rows narrow; pair with `formatDateTime` in a `title` tooltip
 * for the full value.
 */
export function formatClock(value: string | number | null | undefined): string {
  const iso = toTimestampString(value);
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: userTimeZone(),
  });
}

export function formatDateTime(value: string | number | null | undefined): string {
  const iso = toTimestampString(value);
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: userTimeZone(),
    timeZoneName: 'short',
  });
}

export function userTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function formatDuration(ms: number | null | undefined, seconds?: number | null): string {
  let totalSec: number;
  if (ms != null && ms > 0) {
    if (ms < 1000) return `${ms}ms`;
    totalSec = ms / 1000;
  } else if (seconds != null && seconds > 0) {
    totalSec = seconds;
  } else {
    return '—';
  }

  if (totalSec < 10) return `${totalSec.toFixed(1)}s`;
  if (totalSec < 60) return `${Math.round(totalSec)}s`;

  const s = Math.floor(totalSec % 60);
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}
