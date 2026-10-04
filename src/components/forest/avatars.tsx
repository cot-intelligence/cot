/**
 * Workspace marks: a small library of minimal emblems for an agent workspace (prompts, traces,
 * agent graphs, signals). Flat shapes on a soft tint, drawn inline in fixed colours so a pick
 * looks the same in either theme.
 */

type Glyph = 'prompt' | 'trace' | 'graph' | 'signal' | 'branch' | 'stack' | 'orbit' | 'brackets' | 'pulse' | 'grid' | 'shield' | 'loop';

export interface AvatarDesign {
  id: string;
  label: string;
  bg: string;
  fg: string;
  accent: string;
  glyph: Glyph;
}

export const AVATARS: AvatarDesign[] = [
  { id: 'prompt', label: 'Prompt', bg: '#0f5b3e', fg: '#e9f0ea', accent: '#c8f169', glyph: 'prompt' },
  { id: 'trace', label: 'Trace', bg: '#dfe9e2', fg: '#0f5b3e', accent: '#16a065', glyph: 'trace' },
  { id: 'graph', label: 'Graph', bg: '#e3e8ef', fg: '#2b4a7a', accent: '#2b5ce6', glyph: 'graph' },
  { id: 'signal', label: 'Signal', bg: '#0a2a1e', fg: '#e9f0ea', accent: '#c8f169', glyph: 'signal' },
  { id: 'branch', label: 'Branch', bg: '#efe6d8', fg: '#6b4a2b', accent: '#b7791f', glyph: 'branch' },
  { id: 'stack', label: 'Stack', bg: '#e6ece3', fg: '#3d6b55', accent: '#4e8c6f', glyph: 'stack' },
  { id: 'orbit', label: 'Orbit', bg: '#1e2a33', fg: '#e3e8ef', accent: '#7fa2f5', glyph: 'orbit' },
  { id: 'brackets', label: 'Brackets', bg: '#e4e4e7', fg: '#2f3b46', accent: '#0f5b3e', glyph: 'brackets' },
  { id: 'pulse', label: 'Pulse', bg: '#f1e1d9', fg: '#8c3f2b', accent: '#d93a3f', glyph: 'pulse' },
  { id: 'grid', label: 'Field', bg: '#e2ebe6', fg: '#0f5b3e', accent: '#16a065', glyph: 'grid' },
  { id: 'shield', label: 'Guard', bg: '#eee8dc', fg: '#46525c', accent: '#0f5b3e', glyph: 'shield' },
  { id: 'loop', label: 'Loop', bg: '#c8f169', fg: '#0a2a1e', accent: '#0f5b3e', glyph: 'loop' },
];

export const avatarById = (id: string | undefined) => AVATARS.find((a) => a.id === id);

function GlyphShape({ d }: { d: AvatarDesign }) {
  const line = { fill: 'none', stroke: d.fg, strokeWidth: 2.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (d.glyph) {
    case 'prompt': // a shell prompt with a waiting cursor
      return (
        <g>
          <path d="M11 14l6 6-6 6" {...line} />
          <rect x="20" y="24" width="9" height="2.6" rx="1.3" fill={d.accent} />
        </g>
      );
    case 'trace': // a timeline: events on a rail, one flagged
      return (
        <g>
          <path d="M13 10v20" {...line} strokeWidth={1.6} />
          <circle cx="13" cy="12" r="2.6" fill={d.fg} />
          <circle cx="13" cy="20" r="2.6" fill={d.accent} />
          <circle cx="13" cy="28" r="2.6" fill={d.fg} />
          <rect x="18" y="10.8" width="11" height="2.4" rx="1.2" fill={d.fg} />
          <rect x="18" y="18.8" width="8" height="2.4" rx="1.2" fill={d.accent} />
          <rect x="18" y="26.8" width="10" height="2.4" rx="1.2" fill={d.fg} />
        </g>
      );
    case 'graph': // a parent agent with two subagents
      return (
        <g>
          <path d="M20 15v4M20 19l-6 6M20 19l6 6" {...line} strokeWidth={1.8} />
          <circle cx="20" cy="12.5" r="3.6" fill={d.accent} />
          <circle cx="13" cy="27" r="3.2" fill={d.fg} />
          <circle cx="27" cy="27" r="3.2" fill={d.fg} />
        </g>
      );
    case 'signal': // the dot field with one live mark
      return (
        <g fill={d.fg} opacity="0.9">
          {[12, 20, 28].flatMap((y) => [12, 20, 28].map((x) => (x === 28 && y === 12 ? null : <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" opacity="0.55" />)))}
          <circle cx="28" cy="12" r="3" fill={d.accent} opacity="1" />
        </g>
      );
    case 'branch': // a branch splitting off and rejoining
      return (
        <g>
          <path d="M14 10v20M14 16c0 5 12 3 12 8" {...line} />
          <circle cx="14" cy="10" r="2.6" fill={d.fg} />
          <circle cx="14" cy="30" r="2.6" fill={d.fg} />
          <circle cx="26" cy="25" r="2.8" fill={d.accent} />
        </g>
      );
    case 'stack': // layers of context
      return (
        <g>
          <path d="M20 10l10 5-10 5-10-5z" fill={d.accent} />
          <path d="M10 20l10 5 10-5M10 25l10 5 10-5" {...line} strokeWidth={2.2} />
        </g>
      );
    case 'orbit': // an agent circling its work
      return (
        <g>
          <ellipse cx="20" cy="20" rx="11" ry="5.5" transform="rotate(-25 20 20)" {...line} strokeWidth={1.8} />
          <circle cx="20" cy="20" r="3.6" fill={d.fg} />
          <circle cx="29.2" cy="15.3" r="2.4" fill={d.accent} />
        </g>
      );
    case 'brackets': // code
      return (
        <g>
          <path d="M15 11c-3 0-3 2-3 4v2.5c0 1.5-1 2.5-2.5 2.5 1.5 0 2.5 1 2.5 2.5V25c0 2 0 4 3 4M25 11c3 0 3 2 3 4v2.5c0 1.5 1 2.5 2.5 2.5-1.5 0-2.5 1-2.5 2.5V25c0 2 0 4-3 4" {...line} strokeWidth={2.2} />
          <circle cx="20" cy="20" r="2.6" fill={d.accent} />
        </g>
      );
    case 'pulse': // activity over time, one spike flagged
      return (
        <g>
          <path d="M9 22h5l3-7 4 12 3-8h7" {...line} />
          <circle cx="21" cy="27" r="2.4" fill={d.accent} />
        </g>
      );
    case 'grid': // sessions laid out, one open
      return (
        <g>
          {[[11, 11], [21, 11], [11, 21], [21, 21]].map(([x, y], i) => (
            <rect key={i} x={x} y={y} width="8" height="8" rx="2" fill={i === 1 ? d.accent : d.fg} opacity={i === 1 ? 1 : 0.85} />
          ))}
        </g>
      );
    case 'shield': // guard rails
      return (
        <g>
          <path d="M20 9.5l9 3.4v6.4c0 5.8-3.8 9.6-9 11.2-5.2-1.6-9-5.4-9-11.2v-6.4z" {...line} strokeWidth={2.2} />
          <path d="M16 19.8l3 3 5.4-5.6" {...line} stroke={d.accent} strokeWidth={2.4} />
        </g>
      );
    case 'loop': // an agent loop: think, act, observe
      return (
        <g>
          <path d="M27.5 16.5A8.5 8.5 0 1 0 28.5 22" {...line} />
          <path d="M28.6 11.8l-.6 5.2-5.2-.6" {...line} />
          <circle cx="20" cy="20" r="2.6" fill={d.accent} />
        </g>
      );
  }
}

/** The mark itself: a 40×40 drawing that fills whatever box it's given. */
export function AvatarArt({ design, title }: { design: AvatarDesign; title?: string }) {
  return (
    <svg viewBox="0 0 40 40" width="100%" height="100%" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title} style={{ display: 'block' }}>
      <rect width="40" height="40" fill={design.bg} />
      <GlyphShape d={design} />
    </svg>
  );
}

/** The workspace avatar: the picked mark, or the workspace initial on the brand fill. */
export function WorkspaceAvatar({ id, name }: { id: string; name: string }) {
  const design = avatarById(id);
  return <span className="av" data-art={design ? '' : undefined}>{design ? <AvatarArt design={design} /> : name[0]}</span>;
}
