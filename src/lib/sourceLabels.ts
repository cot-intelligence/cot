import type { AgentId } from './agents';

/** Display label for a session source / type. Falls back to a humanized
 *  version of any custom source string (API, custom apps, etc.). */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'claude':
      return 'Claude Code';
    case 'cursor':
      return 'Cursor';
    case 'codex':
      return 'Codex';
    case 'api':
      return 'API';
    case 'custom':
      return 'Custom app';
    default:
      return source
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

/** Short tag used in dense table cells. */
export function sourceTag(source: string): string {
  switch (source) {
    case 'claude':
      return 'CLAUDE';
    case 'cursor':
      return 'CURSOR';
    case 'codex':
      return 'CODEX';
    default:
      return source.toUpperCase();
  }
}

export function isKnownAgent(source: string): source is AgentId {
  return source === 'claude' || source === 'cursor' || source === 'codex';
}
