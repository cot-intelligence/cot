const BASE = 'cot.';

export function setDocumentTitle(segment?: string) {
  document.title = segment ? `${BASE} — ${segment}` : BASE;
}
