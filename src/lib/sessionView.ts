import type { SessionDetail, TimelineItem, TimelineRun } from './api';
import type { IconName } from '../components/ui/icons';
import { toTimestampString } from './categoryMeta';

export interface EditChunk {
  oldText: string;
  newText: string;
}

export interface ParsedDetail {
  command?: string;
  edits?: EditChunk[];
  content?: string;
  url?: string;
  input?: unknown;
  output?: unknown;
  agentResponse?: string;
  text?: string;
  raw: string;
}

function asString(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

function collectEdits(o: Record<string, unknown>, input: Record<string, unknown>): EditChunk[] {
  const chunks: EditChunk[] = [];
  const push = (oldS: unknown, newS: unknown) => {
    if (oldS != null || newS != null) {
      chunks.push({ oldText: asString(oldS), newText: asString(newS) });
    }
  };
  const editArrays = [o.edits, input.edits].filter(Array.isArray) as unknown[][];
  for (const arr of editArrays) {
    for (const e of arr) {
      if (e && typeof e === 'object') {
        const ed = e as Record<string, unknown>;
        push(ed.old_string ?? ed.oldText ?? ed.old, ed.new_string ?? ed.newText ?? ed.new);
      }
    }
  }
  if (!chunks.length) {
    push(input.old_string ?? o.old_string, input.new_string ?? o.new_string);
  }
  return chunks;
}

function contentBlockText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  const content = o.content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as Record<string, unknown>;
      return typeof b.text === 'string' ? b.text : '';
    })
    .filter((text) => text.trim());
  return parts.length ? parts.join('\n\n') : undefined;
}

/** Robustly pull human-meaningful fields out of an event's stored detail blob. */
export function parseDetail(item: TimelineItem): ParsedDetail {
  const raw = item.detail ?? '';
  if (!raw.trim()) return { raw: '' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, raw };
  }
  if (parsed == null || typeof parsed !== 'object') {
    return { text: String(parsed), raw };
  }

  const o = parsed as Record<string, unknown>;
  const input = (o.input && typeof o.input === 'object' ? o.input : o) as Record<string, unknown>;

  const command =
    (typeof o.command === 'string' && o.command) ||
    (typeof input.command === 'string' && input.command) ||
    undefined;

  const edits = collectEdits(o, input);
  const content =
    (typeof input.content === 'string' && input.content) ||
    (typeof o.content === 'string' && o.content) ||
    undefined;
  const url =
    (typeof input.url === 'string' && input.url) ||
    (typeof o.url === 'string' && o.url) ||
    undefined;

  const agentResponse =
    (typeof o.last_assistant_message === 'string' && o.last_assistant_message.trim()
      ? o.last_assistant_message
      : undefined) ||
    contentBlockText(o.response) ||
    contentBlockText(o.tool_response) ||
    contentBlockText(o.output);
  const output = o.response ?? o.result ?? o.output ?? o.tool_response ?? o.tool_output;
  const inputVal = o.input ?? o.arguments ?? o.tool_input;

  return {
    command: command || undefined,
    edits: edits.length ? edits : undefined,
    content,
    url: url || undefined,
    input: inputVal,
    output,
    agentResponse,
    raw,
  };
}

export interface TabDef {
  key: string;
  label: string;
  icon: IconName;
  cats: string[];
}

const TAB_DEFS: TabDef[] = [
  { key: 'files', label: 'Files', icon: 'file', cats: ['file_edit', 'file_read'] },
  { key: 'shell', label: 'Shell', icon: 'terminal', cats: ['shell'] },
  { key: 'mcp', label: 'MCP', icon: 'plug', cats: ['mcp'] },
  { key: 'web', label: 'Web', icon: 'globe', cats: ['web'] },
  { key: 'rules', label: 'Rules & context', icon: 'book', cats: ['context_read'] },
  { key: 'memory', label: 'Memory', icon: 'memory', cats: ['memory'] },
  { key: 'subagents', label: 'Subagents', icon: 'robot', cats: ['subagent'] },
  { key: 'conversation', label: 'Conversation', icon: 'chat', cats: ['prompt', 'question', 'response', 'thought', 'plan'] },
];

export interface ActivityTab extends TabDef {
  count: number;
}

/** Which activity tabs to show, and their item counts, given the timeline. */
export function activityTabsFor(timeline: TimelineItem[]): ActivityTab[] {
  const counts = new Map<string, number>();
  for (const it of timeline) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
  return TAB_DEFS.map((t) => ({
    ...t,
    count: t.cats.reduce((sum, c) => sum + (counts.get(c) ?? 0), 0),
  })).filter((t) => t.count > 0);
}

export function itemsForTab(timeline: TimelineItem[], cats: string[]): TimelineItem[] {
  const set = new Set(cats);
  return timeline.filter((it) => set.has(it.category));
}

export type TimeSort = 'asc' | 'desc';

export function eventTimestamp(item: TimelineItem): string {
  return toTimestampString(item.start_ts || item.ts);
}

export function sortEventsByTime(items: TimelineItem[], order: TimeSort): TimelineItem[] {
  return [...items].sort((a, b) => {
    const cmp = eventTimestamp(a).localeCompare(eventTimestamp(b));
    return order === 'asc' ? cmp : -cmp;
  });
}

/**
 * Categories that represent concrete agent *actions* (as opposed to
 * conversation or lifecycle markers). Only these are attributed to a
 * main-vs-subagent lane by run-window membership.
 */
const ACTION_CATEGORIES = new Set([
  'shell',
  'file_read',
  'file_edit',
  'mcp',
  'web',
  'context_read',
  'memory',
]);

const SUBAGENT_CONTENT_CATEGORIES = new Set([
  ...ACTION_CATEGORIES,
  'response',
  'thought',
  'plan',
  'question',
]);

export type AgentLane = 'main' | 'subagent';

/** A subagent's execution window plus display metadata. */
export interface SubagentRun {
  /** The merged subagent span event (its id keys the group). */
  item: TimelineItem;
  /** Subagent type / description, falling back to a generic label. */
  label: string;
  start: string;
  /** null while the subagent is still running. */
  end: string | null;
  status: string | null;
  durationMs: number | null;
  ongoing: boolean;
  /** What the run represents: a launched subagent or an inlined review. */
  kind: 'subagent' | 'review';
  /**
   * For synthetic spans (Cursor subagents, Codex reviews) the child session
   * whose inlined events this run groups. Native Claude spans leave this unset
   * and fall back to time-window membership.
   */
  childSessionId?: string;
}

function fromReadModelRun(run: TimelineRun): SubagentRun {
  return {
    item: run.item,
    label: run.label,
    start: toTimestampString(run.start),
    end: run.end == null ? null : toTimestampString(run.end),
    status: run.status ?? null,
    durationMs: run.duration_ms ?? null,
    ongoing: run.ongoing,
    kind: run.kind,
    childSessionId: run.child_session_id,
  };
}

function inWindow(ts: string, start: string, end: string | null): boolean {
  if (ts < start) return false;
  return end == null ? true : ts <= end;
}

export function sessionRuns(detail: SessionDetail): SubagentRun[] {
  return detail.timeline_runs.map(fromReadModelRun);
}

/** Whether an action falls within any subagent run window. */
export function itemLane(item: TimelineItem, runs: SubagentRun[]): AgentLane {
  if (!ACTION_CATEGORIES.has(item.category)) return 'main';
  const ts = eventTimestamp(item);
  return runs.some((r) => inWindow(ts, r.start, r.end)) ? 'subagent' : 'main';
}

/** Session that owns an event row (parent session or an inlined review session). */
export function eventSessionId(item: TimelineItem, parentSessionId: string): string {
  return item.owner_session_id ?? parentSessionId;
}

/** Stable key for selection/scrolling when parent and review sessions share event ids. */
export function eventKey(item: TimelineItem, parentSessionId: string): string {
  return `${eventSessionId(item, parentSessionId)}:${item.id}`;
}

/** Action events whose timestamp falls inside a single run's window. */
export function actionsInRun(items: TimelineItem[], run: SubagentRun): TimelineItem[] {
  return items.filter(
    (it) => ACTION_CATEGORIES.has(it.category) && inWindow(eventTimestamp(it), run.start, run.end),
  );
}

/** Events worth showing inside a subagent group. */
export function eventsInRun(items: TimelineItem[], run: SubagentRun): TimelineItem[] {
  // Synthetic spans (Cursor subagents, Codex reviews) own a whole child
  // session: group by that session id so every event nests — including the
  // child's own prompt and lifecycle rows that the category filter would drop.
  if (run.childSessionId) {
    return items.filter(
      (it) => it.owner_session_id === run.childSessionId && it.id !== run.item.id,
    );
  }
  // Native Claude spans: members are whatever falls inside the time window.
  return items.filter(
    (it) => SUBAGENT_CONTENT_CATEGORIES.has(it.category) && inWindow(eventTimestamp(it), run.start, run.end),
  );
}

/** Whether any two runs overlap in time (i.e. ran in parallel). */
export function runsOverlap(runs: SubagentRun[]): boolean {
  const sorted = [...runs].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (prev.end == null || sorted[i].start <= prev.end) return true;
  }
  return false;
}

const CONVERSATION_CATEGORIES = new Set(['prompt', 'response', 'thought']);

export function isConversationCategory(category: string): boolean {
  return CONVERSATION_CATEGORIES.has(category);
}

/** Plain message body for prompt / response / thought events. */
export function conversationMessage(item: TimelineItem, d: ParsedDetail): string | null {
  if (!isConversationCategory(item.category)) return null;
  if (d.text?.trim()) return d.text;
  if (d.content?.trim()) return d.content;
  if (typeof d.output === 'string' && d.output.trim()) return d.output;
  return null;
}

/** Map a metric-card key to the destination tab key. */
export const CARD_TAB: Record<string, string> = {
  events: 'timeline',
  tools: 'timeline',
  files: 'files',
  shell: 'shell',
  mcp: 'mcp',
  web: 'web',
  rules: 'rules',
  subagents: 'subagents',
};

export interface MetricCard {
  key: string;
  label: string;
  value: number;
  icon: IconName;
  accent?: boolean;
}

export function metricCardsFor(detail: SessionDetail): MetricCard[] {
  const { summary, components, timeline } = detail;
  const count = (cat: string) => timeline.filter((t) => t.category === cat).length;
  const cards: MetricCard[] = [
    { key: 'events', label: 'Events', value: summary.event_count, icon: 'event' },
    { key: 'tools', label: 'Tool calls', value: summary.tool_count, icon: 'layers' },
    {
      key: 'files',
      label: 'Files',
      value: components.files_edited.length + components.files_read.length,
      icon: 'file',
      accent: true,
    },
    { key: 'shell', label: 'Shell', value: components.shell_count, icon: 'terminal' },
    { key: 'mcp', label: 'MCP calls', value: count('mcp'), icon: 'plug' },
    { key: 'web', label: 'External', value: components.web_calls.length, icon: 'globe' },
    { key: 'rules', label: 'Rules', value: components.skills_context.length, icon: 'book' },
    { key: 'subagents', label: 'Subagents', value: components.subagents.length, icon: 'robot' },
  ];
  return cards.filter((c) => c.value > 0 || c.key === 'events' || c.key === 'tools');
}

/** Split a posix-ish path into directory + filename for display. */
export function splitPath(path: string): { dir: string; name: string } {
  const clean = path.replace(/\\/g, '/');
  const idx = clean.lastIndexOf('/');
  if (idx === -1) return { dir: '', name: clean };
  return { dir: clean.slice(0, idx), name: clean.slice(idx + 1) };
}
