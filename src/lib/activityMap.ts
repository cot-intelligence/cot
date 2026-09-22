import type { TimelineItem } from './api';

/**
 * High-level "what did the agent touch" map for one session: a few coarse
 * groups (internet, MCP servers, skills, …), each with its top targets as
 * leaves. Every node keeps its events so the UI can jump into the transcript.
 */

export type ActivityKind =
  | 'web'
  | 'mcp'
  | 'skill'
  | 'subagent'
  | 'shell'
  | 'file_edit'
  | 'file_read'
  | 'context'
  | 'memory'
  | 'permission';

export interface ActivityLeaf {
  id: string;
  label: string;
  items: TimelineItem[];
  errors: number;
}

export interface ActivityGroup {
  id: ActivityKind;
  label: string;
  items: TimelineItem[];
  errors: number;
  leaves: ActivityLeaf[];
  /** Everything past the top leaves, rolled into one "+N more" node. */
  overflow: ActivityLeaf | null;
}

const GROUP_ORDER: { kind: ActivityKind; label: string }[] = [
  { kind: 'web', label: 'Internet' },
  { kind: 'mcp', label: 'MCP servers' },
  { kind: 'skill', label: 'Skills' },
  { kind: 'subagent', label: 'Subagents' },
  { kind: 'shell', label: 'Shell' },
  { kind: 'file_edit', label: 'File edits' },
  { kind: 'file_read', label: 'File reads' },
  { kind: 'context', label: 'Context' },
  { kind: 'memory', label: 'Memory' },
  { kind: 'permission', label: 'Permissions' },
];

const MAX_LEAVES = 4;

// Wrappers whose first argument is the real command.
const COMMAND_PREFIXES = new Set(['rtk', 'sudo', 'env', 'time', 'npx', 'uvx', 'exec', 'nohup']);

function isSkill(it: TimelineItem): boolean {
  return it.tool === 'Skill' || it.title === 'Skill';
}

export function activityKind(it: TimelineItem): ActivityKind | null {
  switch (it.category) {
    case 'web':
    case 'mcp':
    case 'subagent':
    case 'shell':
    case 'file_edit':
    case 'file_read':
    case 'memory':
    case 'permission':
      return it.category;
    case 'context_read':
      return isSkill(it) ? 'skill' : 'context';
    default:
      return null;
  }
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

export function commandName(cmd: string): string {
  const segments = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  const seg = segments.find((s) => !/^cd(\s|$)/.test(s)) ?? segments[0] ?? '';
  const words = seg.split(/\s+/).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
  let i = 0;
  while (i < words.length - 1 && COMMAND_PREFIXES.has(words[i])) i++;
  return words[i] ? basename(words[i]) : 'shell';
}

function hostname(target: string): string | null {
  try {
    const host = new URL(target).hostname;
    return host ? host.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

export function leafLabel(kind: ActivityKind, it: TimelineItem): string {
  const target = (it.target ?? '').trim();
  switch (kind) {
    case 'web':
      if (it.tool === 'WebSearch' || it.title === 'WebSearch') return 'web search';
      return hostname(target) ?? (target || 'web');
    case 'mcp':
      return target.split('/')[0] || it.title.replace(/^MCP\s+/, '') || 'mcp';
    case 'skill':
      return target || 'skill';
    case 'subagent':
      return it.title.split(' · ')[0] || 'subagent';
    case 'shell':
      // Search tools (Grep, Glob, …) are titled by tool name; shell commands by their binary.
      return it.title !== 'Shell command' ? it.title : commandName(target);
    case 'file_edit':
    case 'file_read':
    case 'context':
    case 'memory':
      return target ? basename(target) : it.title;
    case 'permission':
      return target || it.title;
  }
}

function isError(it: TimelineItem): boolean {
  return it.status === 'error';
}

function byTime(a: TimelineItem, b: TimelineItem): number {
  return (a.start_ts || a.ts).localeCompare(b.start_ts || b.ts);
}

export function buildActivityMap(items: TimelineItem[]): ActivityGroup[] {
  const byKind = new Map<ActivityKind, Map<string, TimelineItem[]>>();
  for (const it of items) {
    const kind = activityKind(it);
    if (!kind) continue;
    const label = leafLabel(kind, it);
    let leaves = byKind.get(kind);
    if (!leaves) byKind.set(kind, (leaves = new Map()));
    const list = leaves.get(label);
    if (list) list.push(it);
    else leaves.set(label, [it]);
  }

  const groups: ActivityGroup[] = [];
  for (const { kind, label } of GROUP_ORDER) {
    const leafMap = byKind.get(kind);
    if (!leafMap) continue;
    const all = [...leafMap.entries()]
      .map(([leaf, list]): ActivityLeaf => {
        const sorted = [...list].sort(byTime);
        return {
          id: `${kind}:${leaf}`,
          label: leaf,
          items: sorted,
          errors: sorted.filter(isError).length,
        };
      })
      .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));

    // Keep the "+N more" node only when it saves at least two rows.
    const top = all.length > MAX_LEAVES + 1 ? all.slice(0, MAX_LEAVES) : all;
    const rest = all.slice(top.length);
    const overflowItems = rest.flatMap((l) => l.items).sort(byTime);
    const groupItems = all.flatMap((l) => l.items).sort(byTime);

    groups.push({
      id: kind,
      label,
      items: groupItems,
      errors: groupItems.filter(isError).length,
      leaves: top,
      overflow: rest.length
        ? {
            id: `${kind}:__more`,
            label: `+${rest.length} more`,
            items: overflowItems,
            errors: overflowItems.filter(isError).length,
          }
        : null,
    });
  }
  return groups;
}
