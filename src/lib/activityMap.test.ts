import { describe, expect, it } from 'vitest';
import type { TimelineItem } from './api';
import { commandName } from './activityMap';

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
