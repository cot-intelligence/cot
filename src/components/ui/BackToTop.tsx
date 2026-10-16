import { useEffect, useRef, useState } from 'react';
import { Icon } from '../forest/icons';

/**
 * "Back to top" for a long scrolling view: hidden near the top, it appears once
 * the reader is well down the page and returns them to the start. Place it
 * inside the view's scroll container (the dashboard scrolls `.scroll`, not the
 * window); it watches the nearest one around it, so a view that swaps its
 * container (loading, then loaded) never leaves it listening to a stale one.
 */
export function BackToTop({ after = 1.5 }: { after?: number }) {
  const self = useRef<HTMLButtonElement>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    setEl(self.current?.closest<HTMLElement>('.scroll') ?? null);
  }, []);

  useEffect(() => {
    if (!el) return;
    // Past half the page's scroll range (at most `after` screens, at least
    // 300px), so a paged list shows it too, not only an endless one.
    const onScroll = () => {
      const range = el.scrollHeight - el.clientHeight;
      setShown(el.scrollTop > Math.max(300, Math.min(el.clientHeight * after, range / 2)));
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [el, after]);

  const toTop = () => {
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <button ref={self} type="button" className="to-top" data-shown={shown} onClick={toTop} aria-label="Back to top" title="Back to top" tabIndex={shown ? 0 : -1} aria-hidden={!shown}>
      <Icon name="chevron" size={16} style={{ transform: 'rotate(-90deg)' }} />
    </button>
  );
}
