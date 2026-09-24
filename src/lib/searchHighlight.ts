/**
 * Highlights search words inside a timeline card after jumping to it from ⌘K.
 *
 * Painting goes through the CSS Custom Highlight API, so React-owned DOM is
 * never mutated; `::highlight(search-hit)` in index.css styles the ranges.
 */

const HIGHLIGHT_NAME = 'search-hit';
const EDGE_PUNCTUATION = /^[!-/:-@[-`{-~]+|[!-/:-@[-`{-~]+$/g;

/** Word cores of a query, matching the backend's `_search_terms`. */
export function searchTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const t = raw.replace(EDGE_PUNCTUATION, '');
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      terms.push(t);
    }
  }
  return terms;
}

/** Case-insensitive `[start, end)` spans of every term, sorted and merged. */
export function findTermSpans(text: string, terms: string[]): [number, number][] {
  const hay = text.toLowerCase();
  const spans: [number, number][] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      spans.push([i, i + needle.length]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged;
}

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
    ? CSS.highlights
    : null;
}

/** Paint every term under `root`; returns the ranges in document order. */
export function paintSearchHits(root: HTMLElement, terms: string[]): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const [start, end] of findTermSpans(node.textContent ?? '', terms)) {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      ranges.push(range);
    }
  }
  highlightRegistry()?.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  return ranges;
}

export function clearSearchHits(): void {
  stopReveal();
  highlightRegistry()?.delete(HIGHLIGHT_NAME);
}

// Card scrolling re-aligns for ~400ms while nearby rows mount; scroll to the
// first hit after that. Content mounts lazily and tool detail loads on expand,
// so keep repainting as the card changes for a while.
const HIT_SCROLL_DELAY_MS = 450;
const WATCH_MS = 3000;
const PULSE_MS = 2400;

let stopReveal: () => void = () => {};

/** A hit cut off by a truncated line (e.g. an ellipsized path in a card header). */
function clippedSideways(range: Range, card: HTMLElement): boolean {
  const hit = range.getBoundingClientRect();
  if (!hit.width) return true;
  for (let el = range.startContainer.parentElement; el && el !== card; el = el.parentElement) {
    if (getComputedStyle(el).overflowX === 'visible') continue;
    const box = el.getBoundingClientRect();
    if (hit.left < box.left || hit.right > box.right) return true;
  }
  return false;
}

/**
 * Center a range in every scrollable box around it, innermost first. Matches
 * often sit deep in a capped `<pre>`, where scrolling the element into view
 * would only bring the box on screen, not the text inside it.
 */
function scrollRangeIntoView(range: Range): void {
  for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight) continue;
    if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
    const hit = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    el.scrollTop += hit.top - box.top - (el.clientHeight - hit.height) / 2;
  }
}

/** Pulse the jumped-to card, highlight `query` inside it and bring the first hit into view. */
export function revealSearchHits(card: HTMLElement, query: string): void {
  stopReveal();
  const terms = searchTerms(query);
  card.removeAttribute('data-search-target');
  void card.offsetWidth; // restart the pulse when re-targeting the same card
  card.setAttribute('data-search-target', '');

  const start = Date.now();
  let scrolled = false;
  const paint = () => {
    if (!terms.length) return;
    const ranges = paintSearchHits(card, terms);
    if (scrolled || !ranges.length || Date.now() - start < HIT_SCROLL_DELAY_MS) return;
    scrolled = true;
    scrollRangeIntoView(ranges.find((r) => !clippedSideways(r, card)) ?? ranges[0]!);
  };

  const observer = new MutationObserver(paint);
  observer.observe(card, { childList: true, subtree: true, characterData: true });
  const timers = [
    window.setTimeout(paint, HIT_SCROLL_DELAY_MS),
    window.setTimeout(() => observer.disconnect(), WATCH_MS),
    window.setTimeout(() => card.removeAttribute('data-search-target'), PULSE_MS),
  ];
  paint();

  stopReveal = () => {
    observer.disconnect();
    timers.forEach((t) => window.clearTimeout(t));
    card.removeAttribute('data-search-target');
    stopReveal = () => {};
  };
}
