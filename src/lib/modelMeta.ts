// Pretty-print raw model ids into short human labels for badges.
// e.g. claude-opus-4-8 → "Opus 4.8", composer-2.5 → "Composer 2.5",
// gemini-2.5-flash → "Gemini 2.5 Flash", gpt-4o → "GPT-4o".

const SPECIAL_WORDS: Record<string, string> = {
  gpt: 'GPT',
  ai: 'AI',
};

function capitalize(word: string): string {
  const lower = word.toLowerCase();
  if (SPECIAL_WORDS[lower]) return SPECIAL_WORDS[lower];
  // Keep tokens that contain a digit as-is (e.g. "4o", "2.5").
  if (/\d/.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function formatModel(id: string | null | undefined): string {
  if (!id) return '';
  // Anthropic ids: claude-<family>-<maj>-<min>[-date] → "Family maj.min".
  const claude = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i);
  if (claude) return `${capitalize(claude[1])} ${claude[2]}.${claude[3]}`;
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ');
}
