// Shared chart constants/types. Kept value-export-only (no components) so the
// chart component modules stay Fast-Refresh friendly.

export const CHART_COLORS = [
  '#FF4500', // vermilion
  '#2B5CE6', // cobalt
  '#3A4D39', // olive (light; UI uses theme-aware --olive via Tailwind)
  '#E0991F', // amber
  '#7A5CC8', // violet
  '#1FA88F', // teal
  '#C8487A', // magenta
  '#5C8A2B', // moss
];

export interface Datum {
  name: string;
  value: number;
  color?: string;
}
