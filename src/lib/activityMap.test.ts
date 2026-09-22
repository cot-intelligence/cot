import { describe, expect, it } from 'vitest';
import type { TimelineItem } from './api';
import { buildActivityMap, commandName } from './activityMap';

let nextId = 1;
function ev(partial: Partial<TimelineItem>): TimelineItem {
  const id = nextId++;
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString();
  return {
    id,
    tool: null,
    ts,
    start_ts: ts,
    end_ts: null,
    source: 'claude',
    category: 'other',
    title: '',
    detail: null,
    target: null,
    status: 'ok',
    duration_ms: null,
    model: null,
    attachments: null,
    ...partial,
  } as TimelineItem;
}

describe('commandName', () => {
  it('skips cd, env assignments and wrapper commands', () => {
    expect(commandName('cd /repo && git status')).toBe('git');
    expect(commandName('FOO=1 rtk npm test')).toBe('npm');
    expect(commandName('/usr/bin/python3 x.py | head')).toBe('python3');
  });
});

describe('buildActivityMap', () => {
  it('groups by high-level destination and splits skills out of context reads', () => {
    const groups = buildActivityMap([
      ev({ category: 'web', title: 'WebFetch', target: 'https://www.github.com/a' }),
      ev({ category: 'web', title: 'WebFetch', target: 'https://github.com/b', status: 'error' }),
      ev({ category: 'web', title: 'WebSearch', tool: 'WebSearch', target: 'react 19' }),
      ev({ category: 'mcp', title: 'MCP linear', target: 'linear/list_issues' }),
      ev({ category: 'context_read', title: 'Skill', tool: 'Skill', target: 'tdd' }),
      ev({ category: 'context_read', title: 'Read file', target: '/repo/CLAUDE.md' }),
      ev({ category: 'prompt', title: 'hi' }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(['web', 'mcp', 'skill', 'context']);
    const web = groups[0];
    expect(web.leaves.map((l) => [l.label, l.items.length])).toEqual([
      ['github.com', 2],
      ['web search', 1],
    ]);
    expect(web.errors).toBe(1);
    expect(groups[1].leaves[0].label).toBe('linear');
    expect(groups[3].leaves[0].label).toBe('CLAUDE.md');
  });

  it('rolls the long tail into one overflow leaf', () => {
    const groups = buildActivityMap(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((f) => ev({ category: 'file_read', target: `/r/${f}.ts` })),
    );
    expect(groups[0].leaves).toHaveLength(4);
    expect(groups[0].overflow?.label).toBe('+2 more');
    expect(groups[0].overflow?.items).toHaveLength(2);
  });
});
