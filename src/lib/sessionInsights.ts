import type { SessionDetail } from './api';
import type { IconName } from '../components/ui/icons';
import { formatDuration } from './categoryMeta';
import { splitPath } from './sessionView';

export interface Insight {
  icon: IconName;
  title: string;
  detail: string;
  tone?: 'default' | 'accent' | 'warn';
}

function uniqueDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) dirs.add(splitPath(p).dir || '.');
  return [...dirs];
}

function list(items: string[], max = 4): string {
  if (!items.length) return '';
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} +${items.length - max} more`;
}

export interface SessionInsights {
  summary: string;
  insights: Insight[];
}

export function buildInsights(detail: SessionDetail): SessionInsights {
  const { summary, components, events } = detail;
  const insights: Insight[] = [];

  const dur = formatDuration(null, summary.duration_seconds);
  const verb = summary.status === 'active' ? 'is running' : 'completed';
  const narrative =
    `This ${summary.source} session ${verb} with ${summary.event_count} events` +
    `${summary.tool_count ? ` and ${summary.tool_count} tool calls` : ''}` +
    `${summary.duration_seconds ? ` over ${dur}` : ''}.`;

  const editedPaths = components.files_edited.map((f) => f.path || '').filter(Boolean);
  if (editedPaths.length) {
    const dirs = uniqueDirs(editedPaths);
    insights.push({
      icon: 'edit',
      tone: 'accent',
      title: `Modified ${editedPaths.length} file${editedPaths.length > 1 ? 's' : ''}`,
      detail:
        `Across ${dirs.length} director${dirs.length > 1 ? 'ies' : 'y'}: ` +
        list(editedPaths.map((p) => splitPath(p).name)),
    });
  }

  const readPaths = components.files_read.map((f) => f.path || '').filter(Boolean);
  if (readPaths.length) {
    insights.push({
      icon: 'read',
      title: `Read ${readPaths.length} file${readPaths.length > 1 ? 's' : ''}`,
      detail: list(readPaths.map((p) => splitPath(p).name)),
    });
  }

  if (components.mcp_plugins.length) {
    const servers = new Set<string>();
    for (const m of components.mcp_plugins) {
      const t = m.target || '';
      servers.add(t.split('/')[0] || t);
    }
    insights.push({
      icon: 'plug',
      tone: 'accent',
      title: `Called ${components.mcp_plugins.length} MCP tool${components.mcp_plugins.length > 1 ? 's' : ''}`,
      detail: `Server${servers.size > 1 ? 's' : ''}: ${list([...servers])}`,
    });
  }

  if (components.web_calls.length) {
    const domains = new Set<string>();
    for (const w of components.web_calls) {
      const t = w.target || '';
      try {
        domains.add(new URL(t).hostname);
      } catch {
        domains.add(t.slice(0, 40));
      }
    }
    insights.push({
      icon: 'globe',
      title: `Reached ${components.web_calls.length} external endpoint${components.web_calls.length > 1 ? 's' : ''}`,
      detail: list([...domains]),
    });
  }

  if (components.shell_count) {
    insights.push({
      icon: 'terminal',
      title: `Ran ${components.shell_count} shell command${components.shell_count > 1 ? 's' : ''}`,
      detail: list(
        events.filter((t) => t.category === 'shell').map((t) => t.target || t.title),
      ),
    });
  }

  if (components.skills_context.length) {
    insights.push({
      icon: 'book',
      title: `Consulted ${components.skills_context.length} rule/context file${components.skills_context.length > 1 ? 's' : ''}`,
      detail: list(components.skills_context.map((f) => splitPath(f.path || '').name)),
    });
  }

  if (components.subagents.length) {
    insights.push({
      icon: 'robot',
      title: `Spawned ${components.subagents.length} subagent${components.subagents.length > 1 ? 's' : ''}`,
      detail: list(components.subagents.map((s) => s.target || 'subagent')),
    });
  }

  const errors = events.filter((t) => t.status === 'error' || t.status === 'blocked');
  if (errors.length) {
    insights.push({
      icon: 'warn',
      tone: 'warn',
      title: `${errors.length} error${errors.length > 1 ? 's' : ''} / blocked action${errors.length > 1 ? 's' : ''}`,
      detail: list(errors.map((e) => e.title)),
    });
  }

  const stopped = events.filter((t) => t.status === 'interrupted');
  if (stopped.length) {
    const stoppedResponses = stopped.filter((t) => t.category === 'response').length;
    const stoppedThoughts = stopped.filter((t) => t.category === 'thought').length;
    const parts: string[] = [];
    if (stoppedResponses) parts.push(`${stoppedResponses} response${stoppedResponses > 1 ? 's' : ''}`);
    if (stoppedThoughts) parts.push(`${stoppedThoughts} thought${stoppedThoughts > 1 ? 's' : ''}`);
    insights.push({
      icon: 'stop',
      tone: 'warn',
      title: `${stopped.length} stopped output${stopped.length > 1 ? 's' : ''}`,
      detail: `The user interrupted the agent mid-turn${parts.length ? ` (${parts.join(', ')})` : ''}.`,
    });
  }

  if (components.prompt_count || components.response_count) {
    insights.push({
      icon: 'chat',
      title: `${components.prompt_count} prompt${components.prompt_count === 1 ? '' : 's'}, ${components.response_count} response${components.response_count === 1 ? '' : 's'}`,
      detail: 'Conversation turns between the user and the agent.',
    });
  }

  const counts = summary.category_counts || {};
  const busiest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (busiest && busiest[1] > 0) {
    insights.push({
      icon: 'event',
      title: `Most frequent activity: ${busiest[0].replace('_', ' ')}`,
      detail: `${busiest[1]} of ${summary.event_count} events.`,
    });
  }

  return { summary: narrative, insights };
}
