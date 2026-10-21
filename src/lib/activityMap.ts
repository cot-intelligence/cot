import type { TimelineItem } from './api';

/**
 * Naming helpers for session events: the coarse kind of thing an event touched
 * (internet, MCP server, skill, …) and a short label for its target. The flow
 * graph (flowGraph.ts) names its steps with these.
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
