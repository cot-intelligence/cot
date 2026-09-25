/**
 * The text re-indented, when it is a JSON object or array that parses; null
 * otherwise. Scalars ("42", "true") are left alone: they read fine as-is and
 * too much plain text happens to be one.
 */
export function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  const opener = trimmed[0];
  if (opener !== '{' && opener !== '[') return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

/** A captured tool value as display text, with JSON beautified. */
export function displayValue(value: unknown): string {
  if (typeof value === 'string') return prettyJson(value) ?? value;
  return JSON.stringify(value, null, 2);
}
