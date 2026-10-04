// Shared chart constants/types. Kept value-export-only (no components) so the
// chart component modules stay Fast-Refresh friendly.

// Series colours. The first four follow the theme tokens (Signal Forest);
// the rest are fixed mid-tones that read on both grounds.
export const CHART_COLORS = [
  'rgb(var(--hot))',
  'rgb(var(--cobalt))',
  'rgb(var(--amber))',
  'rgb(var(--olive))',
  '#8B6FD6', // violet
  '#2BA3A3', // teal
  '#C8487A', // magenta
  '#7E8F5C', // moss
];

export interface Datum {
  name: string;
  value: number;
  color?: string;
}
