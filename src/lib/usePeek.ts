import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react';

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 250;

/**
 * Hover-to-peek for a collapsed sidebar: pointer or keyboard focus opens it
 * temporarily, leaving closes it again. The saved collapsed/open preference is
 * untouched. The short open delay stops a cursor passing over the rail from
 * flashing the panel open; the close delay forgives brief slips off its edge.
 */
export function usePeek(enabled: boolean) {
  const [peek, setPeek] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const schedule = useCallback((next: boolean, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPeek(next), delay);
  }, []);

  // Pinning the sidebar open (or unmounting) ends any peek in flight.
  useEffect(() => {
    if (!enabled) {
      window.clearTimeout(timer.current);
      setPeek(false);
    }
  }, [enabled]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const handlers = {
    onMouseEnter: () => enabled && schedule(true, OPEN_DELAY_MS),
    onMouseLeave: () => enabled && schedule(false, CLOSE_DELAY_MS),
    onFocus: () => enabled && schedule(true, 0),
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (enabled && !e.currentTarget.contains(e.relatedTarget as Node | null)) schedule(false, 0);
    },
  };

  return { peek: enabled && peek, handlers };
}
