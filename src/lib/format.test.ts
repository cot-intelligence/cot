import { describe, expect, it } from 'vitest';
import { compact, hourLabel, formatMetricsDay, formatCost, formatBytes } from './format';

describe('compact', () => {
  it('passes small numbers through', () => {
    expect(compact(0)).toBe('0');
    expect(compact(999)).toBe('999');
  });

  it('uses K with one decimal under 10k and none at/above', () => {
    expect(compact(1_000)).toBe('1.0K');
    expect(compact(9_990)).toBe('10.0K');
    expect(compact(10_000)).toBe('10K');
    expect(compact(12_400)).toBe('12K');
  });

  it('uses M with one decimal under 10M and none at/above', () => {
    expect(compact(1_500_000)).toBe('1.5M');
    expect(compact(10_000_000)).toBe('10M');
  });
});

describe('hourLabel', () => {
  it('maps midnight and noon to 12', () => {
    expect(hourLabel(0)).toBe('12am');
    expect(hourLabel(12)).toBe('12pm');
  });

  it('labels am/pm around the boundaries', () => {
    expect(hourLabel(1)).toBe('1am');
    expect(hourLabel(11)).toBe('11am');
    expect(hourLabel(13)).toBe('1pm');
    expect(hourLabel(23)).toBe('11pm');
  });
});

describe('formatCost', () => {
  it('tiers precision by magnitude', () => {
    expect(formatCost(2500)).toBe('$2.5k');
    expect(formatCost(250)).toBe('$250');
    expect(formatCost(12.5)).toBe('$12.5');
    expect(formatCost(1.23)).toBe('$1.23');
  });

  it('handles sub-cent and zero', () => {
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0)).toBe('$0');
  });
});

describe('formatBytes', () => {
  it('handles zero and non-finite', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
  });

  it('scales through units with sensible precision', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(419_430_400)).toBe('400 MB');
    expect(formatBytes(1024 ** 3)).toBe('1 GB');
  });
});

describe('formatMetricsDay', () => {
  it('returns the input unchanged for malformed keys', () => {
    expect(formatMetricsDay('not-a-date')).toBe('not-a-date');
    expect(formatMetricsDay('')).toBe('');
  });

  it('formats a valid ISO day to a short label', () => {
    // Locale-dependent formatting, so assert it changed shape rather than exact text.
    const out = formatMetricsDay('2026-03-09');
    expect(out).not.toBe('2026-03-09');
    expect(out).toMatch(/\d/);
  });
});
