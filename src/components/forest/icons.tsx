/** Line icons on a 24px grid, round caps, currentColor. Stroke width is set per variant. */
const P: Record<string, string> = {
  overview: 'M4 13h6V4H4zM14 20h6v-9h-6zM14 4h6v3h-6zM4 17h6v3H4z',
  sessions: 'M4 6h16M4 12h16M4 18h10',
  trace: 'M5 4v16M5 7h8M5 12h12M5 17h6',
  findings: 'M12 3l8 4v5c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V7zM12 8v5M12 16.5v.01',
  activity: 'M4 17l5-5-5-5M12 19h8',
  governance: 'M12 3l7 3v6c0 4-3 7.5-7 9-4-1.5-7-5-7-9V6zM9 12l2 2 4-4',
  audit: 'M8 4h8l3 3v13H5V4zM9 11h6M9 15h6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M5 12l5 5 9-10',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9z',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  shell: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z',
  prompt: 'M4 5h16v11H9l-5 4z',
  reply: 'M20 5H4v11h11l5 4z',
  thought: 'M12 4a6 6 0 0 0-4 10.5V17h8v-2.5A6 6 0 0 0 12 4zM9 20h6',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21c0-3.9 3.1-7 7-7s7 3.1 7 7M17 11a3 3 0 1 0 0-6M22 20c0-3-1.9-5.5-4.5-6.4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  dollar: 'M12 3v18M16.5 7.5C16 6 14.3 5 12 5 9.5 5 7.5 6.3 7.5 8.3c0 4.4 9 2.4 9 7 0 2-2 3.4-4.5 3.4-2.4 0-4.2-1-4.8-2.7',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  sidebar: 'M4 5h16v14H4zM9.5 5v14',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  pulse: 'M3 12h4l3-7 4 14 3-7h4',
  key: 'M14 10a5 5 0 1 0-1.5 3.5L20 21M16 17l2-2',
  replay: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M12 8v4l3 2',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  trash: 'M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  archive: 'M4 5h16v4H4zM5 9v10h14V9M10 13h4',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, stroke = 1.6, className, style }: { name: string; size?: number; stroke?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={{ flex: 'none', ...style }}>
      <path d={P[name] ?? P.file} />
    </svg>
  );
}

export const CATEGORY_ICON: Record<string, string> = {
  prompt: 'prompt', response: 'reply', thought: 'thought', shell: 'shell', file_read: 'file', file_edit: 'edit',
  web: 'globe', mcp: 'plug', lifecycle: 'pulse', meta: 'layers', context_read: 'file', subagent: 'users', permission: 'lock', error: 'bolt',
  question: 'prompt', plan: 'trace', compaction: 'layers', memory: 'database', notification: 'bolt', other: 'file',
};
