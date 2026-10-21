import { describe, expect, it } from 'vitest';
import type { TimelineItem } from './api';
import { END_ID, START_ID, buildAggregatedFlow, buildExpandedFlow, buildTurns, flowItems, flowSteps, mainPaths } from './flowGraph';

let nextId = 1;
/** An event starting `at` seconds in, lasting `dur` seconds (0 = instant). */
function ev(at: number, partial: Partial<TimelineItem>, dur = 0): TimelineItem {
  const id = nextId++;
  const start = new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString();
  return {
    id,
    tool: null,
    ts: start,
    start_ts: start,
    end_ts: dur ? new Date(Date.UTC(2026, 0, 1, 0, 0, at + dur)).toISOString() : null,
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

const prompt = (at: number) => ev(at, { category: 'prompt', title: 'Prompt' });
const read = (at: number, path: string, dur = 0) => ev(at, { category: 'file_read', title: 'Read', target: path }, dur);
const edit = (at: number, path: string) => ev(at, { category: 'file_edit', title: 'Edit', target: path });
const bash = (at: number, cmd: string, status = 'ok') =>
  ev(at, { category: 'shell', title: 'Shell command', target: cmd, status });
const reply = (at: number) => ev(at, { category: 'response', title: 'Response' });

describe('flowSteps', () => {
  it('puts overlapping spans in one step and sequential events in their own', () => {
    const a = read(0, '/a.ts', 5);
    const b = read(1, '/b.ts', 2);
    const c = bash(10, 'git status');
    const steps = flowSteps(flowItems([c, b, a]));
    expect(steps.map((s) => s.map((it) => it.id))).toEqual([[a.id, b.id], [c.id]]);
  });

  it('leaves an event that starts after another member finished for a later step', () => {
    const a = read(0, '/a.ts', 10);
    const b = read(1, '/b.ts', 1); // ends at 2
    const c = read(5, '/c.ts', 1); // overlaps a, but starts after b ended
    const steps = flowSteps(flowItems([a, b, c]));
    expect(steps.map((s) => s.map((it) => it.id))).toEqual([[a.id, b.id], [c.id]]);
  });
});

describe('buildAggregatedFlow', () => {
  it('collapses repeats by step name and draws the loop as a cycle', () => {
    const graph = buildAggregatedFlow([
      prompt(0),
      read(1, '/a.ts'),
      edit(2, '/a.ts'),
      bash(3, 'cd /repo && rtk npm test', 'error'),
      read(4, '/b.ts'),
      edit(5, '/b.ts'),
      bash(6, 'npm test'),
      reply(7),
      ev(8, { category: 'lifecycle', title: 'Stop' }),
    ]);
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    expect(graph.nodes.map((n) => n.label)).toEqual(['Start', 'You', 'Read', 'Edit', 'npm', 'Reply', 'End']);
    expect(byId['file_read:Read'].items).toHaveLength(2);
    expect(byId['shell:npm'].errors).toBe(1);

    const edges = Object.fromEntries(graph.edges.map((e) => [e.id, e.count]));
    expect(edges).toEqual({
      [`${START_ID}->prompt:You`]: 1,
      'prompt:You->file_read:Read': 1,
      'file_read:Read->file_edit:Edit': 2,
      'file_edit:Edit->shell:npm': 2,
      'shell:npm->file_read:Read': 1, // the loop back
      'shell:npm->response:Reply': 1,
      [`response:Reply->${END_ID}`]: 1,
    });
  });

  it('forks into parallel steps and joins after them, without self-loops', () => {
    const graph = buildAggregatedFlow([
      prompt(0),
      read(1, '/a.ts', 3),
      bash(2, 'git log'),
      read(10, '/b.ts'),
      read(11, '/c.ts'),
    ]);
    const ids = graph.edges.map((e) => e.id).sort();
    expect(ids).toEqual(
      [
        `${START_ID}->prompt:You`,
        'prompt:You->file_read:Read',
        'prompt:You->shell:git',
        'shell:git->file_read:Read',
        `file_read:Read->${END_ID}`,
      ].sort(),
    );
  });

  it('skips rows inlined from subagent runs and returns nothing for an empty run', () => {
    expect(buildAggregatedFlow([read(0, '/a.ts')].map((it) => ({ ...it, provenance: 'subagent' as const }))).nodes).toEqual([]);
  });
});

describe('buildExpandedFlow', () => {
  it('gives every event its own node and caps the graph', () => {
    const items = [prompt(0), read(1, '/src/a.ts'), read(2, '/src/b.ts'), reply(3)];
    const graph = buildExpandedFlow(items, 3);
    expect(graph.nodes.map((n) => n.label)).toEqual(['Start', 'You', 'Read a.ts', 'Read b.ts', 'End']);
    expect(graph.truncated).toBe(1);
    expect(graph.edges.map((e) => e.to)).toEqual([`e:${items[0].id}`, `e:${items[1].id}`, `e:${items[2].id}`, END_ID]);
  });
});

describe('buildTurns', () => {
  it('opens a turn at each prompt and keeps earlier steps in a headless one', () => {
    const early = read(0, '/boot.md');
    const p1 = prompt(1);
    const a = bash(2, 'git status', 'error');
    const r1 = reply(5);
    const p2 = prompt(10);
    const r2 = reply(11);
    const turns = buildTurns([r2, p2, r1, a, p1, early]);
    expect(turns.map((t) => [t.prompt?.id ?? null, t.items.map((i) => i.id)])).toEqual([
      [null, [early.id]],
      [p1.id, [a.id, r1.id]],
      [p2.id, [r2.id]],
    ]);
    expect(turns[1].errors).toBe(1);
    expect(turns[1].durationMs).toBe(4000);
  });

  it('groups steps that ran at the same time, as the graph does', () => {
    const p = prompt(0);
    const plan = ev(1, { category: 'mcp', title: 'MCP', target: 'ccd_turn/update_plan' }, 1);
    const cmd = bash(1, 'sed -n 1,55p x.tsx');
    const next = bash(5, 'sed -n 175,240p y.css');
    const [turn] = buildTurns([p, plan, cmd, next]);
    expect(turn.steps.map((s) => s.map((it) => it.id))).toEqual([[plan.id, cmd.id], [next.id]]);
  });
});

describe('mainPaths', () => {
  const node = (id: string) => ({ id, label: id, kind: 'shell', items: [], errors: 0 });
  const edge = (from: string, to: string, count: number) => ({ id: `${from}->${to}`, from, to, count });

  it('drops a rare way out when its target is already reached by a stronger one', () => {
    const graph = {
      nodes: ['A', 'B', 'C'].map(node),
      edges: [edge('A', 'B', 10), edge('A', 'C', 1), edge('B', 'C', 5)],
      truncated: 0,
    };
    expect(mainPaths(graph).edges.map((e) => e.id)).toEqual(['A->B', 'B->C']);
  });

  it('keeps a node\'s only way in, however rare, so it never floats', () => {
    const graph = {
      nodes: ['A', 'B', 'D'].map(node),
      edges: [edge('A', 'B', 10), edge('A', 'D', 1)],
      truncated: 0,
    };
    expect(mainPaths(graph).edges.map((e) => e.id)).toEqual(['A->B', 'A->D']);
  });
});
