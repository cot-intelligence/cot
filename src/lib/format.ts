export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export function hourLabel(h: number): string {
  const p = h < 12 ? 'am' : 'pm';
  return `${h % 12 === 0 ? 12 : h % 12}${p}`;
}
