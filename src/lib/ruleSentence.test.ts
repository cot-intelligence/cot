import { describe, expect, it } from 'vitest';
import type { RuleSpec } from './api';
import { autoName, blankSentence, fromSpec, toSpec } from './ruleSentence';

const base = { pillar: 'security', severity: 'warn' } as const;

describe('rule sentence', () => {
  it('builds a match rule from a sentence', () => {
    const s = { ...blankSentence('shell'), conds: [{ field: 'target', op: 'contains', value: 'npm install' }] };
    const spec = toSpec(s);
    expect(spec.type).toBe('match');
    expect(spec.when).toEqual({ all: [{ field: 'category', op: 'eq', value: 'shell' }, { field: 'target', op: 'contains', value: 'npm install' }] });
    expect(spec.name).toBe('Agent runs a command where command contains npm install');
  });

  it('drops empty conditions so the preview shows everything of that kind', () => {
    const spec = toSpec(blankSentence('read'));
    expect(spec.when).toEqual({ all: [{ field: 'category', op: 'in', value: ['file_read', 'context_read'] }] });
  });

  it('keeps a valid condition for "does anything" with nothing filled in', () => {
    expect(toSpec(blankSentence('any')).when).toEqual({ all: [{ field: 'category', op: 'exists' }] });
  });

  it('wraps "or" conditions and adds failure and limits', () => {
    const s = {
      ...blankSentence('shell'),
      join: 'or' as const,
      conds: [{ field: 'target', op: 'contains', value: 'a' }, { field: 'target', op: 'contains', value: 'b' }],
      fails: true,
      limit: { count: 3, per: 'session' },
    };
    const spec = toSpec(s);
    expect(spec.type).toBe('threshold');
    expect(spec.pillar).toBe('usability');
    expect(spec.threshold).toEqual({ group_by: ['session'], aggregate: 'count', op: 'gte', value: 3 });
    expect((spec.when as { all: unknown[] }).all[2]).toEqual({ any: s.conds });
  });

  it('round-trips every shape it can express', () => {
    const shapes = [
      { ...blankSentence('shell'), conds: [{ field: 'target', op: 'is_risky_command' }] },
      { ...blankSentence('mcp'), conds: [{ field: 'mcp_server', op: 'eq', value: 'github' }], fails: true, limit: { count: 5, per: 'mcp_server' } },
      { ...blankSentence('edit'), agent: 'cursor', projects: ['~/work/*'], conds: [{ field: 'target', op: 'glob', value: '*.tf' }] },
      { ...blankSentence('spend'), budget: { amount: 10, per: 'project' } },
    ];
    for (const s of shapes) {
      const spec = toSpec(s);
      const back = fromSpec(spec);
      expect(back).not.toBeNull();
      expect(toSpec(back!)).toEqual(spec);
    }
  });

  it('reads the built-in templates', () => {
    const flaky: RuleSpec = {
      ...base, name: 'Flaky MCP server', type: 'threshold',
      when: { all: [{ field: 'category', op: 'eq', value: 'mcp' }, { field: 'status', op: 'eq', value: 'error' }] },
      threshold: { group_by: ['mcp_server'], aggregate: 'count', op: 'gte', value: 5 },
    };
    const s = fromSpec(flaky)!;
    expect(s.verb).toBe('mcp');
    expect(s.fails).toBe(true);
    expect(s.limit).toEqual({ count: 5, per: 'mcp_server' });
  });

  it('sends anything else to the advanced editor', () => {
    const nested: RuleSpec = { ...base, name: 'x', type: 'match', when: { all: [{ not: { field: 'tool', op: 'eq', value: 'x' } }] } };
    const twoAgents: RuleSpec = { ...base, name: 'x', type: 'match', scope: { sources: ['claude', 'cursor'], projects: [] }, when: { all: [{ field: 'tool', op: 'eq', value: 'x' }] } };
    const otherField: RuleSpec = { ...base, name: 'x', type: 'match', when: { all: [{ field: 'category', op: 'eq', value: 'shell' }, { field: 'duration_ms', op: 'gt', value: 1 }] } };
    expect(fromSpec(nested)).toBeNull();
    expect(fromSpec(twoAgents)).toBeNull();
    expect(fromSpec(otherField)).toBeNull();
  });

  it('keeps a typed name and a chosen subject', () => {
    const spec: RuleSpec = { ...base, name: 'Mine', type: 'match', subject: 'tool', when: { all: [{ field: 'category', op: 'eq', value: 'mcp' }] } };
    const s = fromSpec(spec)!;
    expect(toSpec(s).name).toBe('Mine');
    expect(toSpec(s).subject).toBe('tool');
    expect(autoName({ ...s, nameTouched: false })).toBe('Agent calls an MCP tool');
  });
});
