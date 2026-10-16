import { useEffect, useState } from 'react';
import { Icon } from '../forest/icons';

/**
 * "Back to top" for a long scrolling view: hidden near the top, it appears once
 * the reader is well down the page and returns them to the start. Watches
 * the view's scroll container (the dashboard scrolls `#vf-scroll`, not the window).
 */
export function BackToTop({ scrollId = 'vf-scroll', after = 1.5 }: { scrollId?: string; after?: number }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    setEl(document.getElementById(scrollId));
  }, [scrollId]);

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
    <button type="button" className="to-top" data-shown={shown} onClick={toTop} aria-label="Back to top" title="Back to top" tabIndex={shown ? 0 : -1} aria-hidden={!shown}>
      <Icon name="chevron" size={16} style={{ transform: 'rotate(-90deg)' }} />
    </button>
  );
}
