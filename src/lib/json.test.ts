import { describe, expect, it } from 'vitest';
import { displayValue, prettyJson } from './json';

describe('prettyJson', () => {
  it('re-indents a valid object or array', () => {
    expect(prettyJson('{"a":1,"b":[true,null]}')).toBe('{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
    expect(prettyJson('  [1,2]\n')).toBe('[\n  1,\n  2\n]');
  });

  it('leaves text that fails to parse alone', () => {
    expect(prettyJson('{"a":1,}')).toBeNull();
    expect(prettyJson('{ not json }')).toBeNull();
    expect(prettyJson('[1, 2')).toBeNull();
  });

  it('ignores JSON scalars and plain text', () => {
    expect(prettyJson('42')).toBeNull();
    expect(prettyJson('"quoted"')).toBeNull();
    expect(prettyJson('true')).toBeNull();
    expect(prettyJson('hello')).toBeNull();
    expect(prettyJson('')).toBeNull();
  });
});

describe('displayValue', () => {
  it('beautifies a JSON string and stringifies structured values', () => {
    expect(displayValue('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(displayValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('passes other strings through untouched', () => {
    expect(displayValue('exit 0\n')).toBe('exit 0\n');
  });
});
