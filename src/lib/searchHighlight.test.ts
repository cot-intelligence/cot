import { describe, expect, it } from 'vitest';
import { findTermSpans, searchTerms } from './searchHighlight';

describe('searchTerms', () => {
  it('splits on whitespace and trims edge punctuation like the backend', () => {
    expect(searchTerms('  fix "auth**, token  ')).toEqual(['fix', 'auth', 'token']);
  });

  it('drops duplicates case-insensitively', () => {
    expect(searchTerms('Auth auth AUTH')).toEqual(['Auth']);
  });
});

describe('findTermSpans', () => {
  it('finds every occurrence of every term, case-insensitively, in order', () => {
    expect(findTermSpans('Auth then auth token', ['auth', 'token'])).toEqual([
      [0, 4],
      [10, 14],
      [15, 20],
    ]);
  });

  it('merges overlapping matches so a span is painted once', () => {
    expect(findTermSpans('migration', ['migra', 'ration'])).toEqual([[0, 9]]);
  });

  it('returns nothing without terms or matches', () => {
    expect(findTermSpans('hello', [])).toEqual([]);
    expect(findTermSpans('hello', ['bye'])).toEqual([]);
  });
});
