/**
 * Chip tones from the Signal Forest style lock: colour tinted over the ground,
 * an inset ring, full colour for the word. Pair with the `.chip` class.
 */
export const TONE = {
  critical: 'bg-alert/[0.14] text-alert ring-alert/[0.32]',
  warn: 'bg-amber/[0.14] text-amber ring-amber/[0.32]',
  info: 'bg-cobalt/[0.14] text-cobalt ring-cobalt/[0.32]',
  ok: 'bg-olive/[0.14] text-olive ring-olive/[0.32]',
  hot: 'bg-hot/[0.14] text-hot ring-hot/[0.32]',
  neutral: 'bg-fg/[0.06] text-fg/60 ring-line/[0.16]',
} as const;

export type Tone = keyof typeof TONE;
