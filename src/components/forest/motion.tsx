import { animate, motion, useInView, useReducedMotion, type HTMLMotionProps } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;

/** True only during the first moments after load. A dashboard is opened dozens of times a day: entrance choreography
 *  plays once, then pages, filters and ranges swap instantly. Read it once per mount (useState(intro)). */
const T0 = performance.now();
export const intro = () => performance.now() - T0 < 1200;

/** Fade + rise + blur-clear when scrolled into view, once. */
export function Reveal({
  children, delay = 0, y = 24, blur = 6, as = 'div', ...rest
}: { children: ReactNode; delay?: number; y?: number; blur?: number; as?: 'div' | 'section' | 'li' } & HTMLMotionProps<'div'>) {
  const reduce = useReducedMotion();
  const M = motion[as] as typeof motion.div;
  return (
    <M
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: `translateY(${y}px)`, filter: `blur(${blur}px)` }}
      whileInView={reduce ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0px)', filter: 'blur(0px)' }}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ duration: reduce ? 0.2 : 0.8, delay, ease: EASE_OUT }}
      {...rest}
    >
      {children}
    </M>
  );
}

/** Staggered children for lists and tables when data arrives. App-shell motion: short and quick. */
export const listParent = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } };
export const listItem = {
  hidden: { opacity: 0, transform: 'translateY(6px)' },
  show: { opacity: 1, transform: 'translateY(0px)', transition: { duration: 0.24, ease: EASE_OUT } },
};

/** Counts up once when visible. Renders the final value immediately under reduced motion. */
export function CountUp({ value, format, duration = 1.1 }: { value: number; format: (n: number) => string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' });
  const reduce = useReducedMotion();
  const [v, setV] = useState(reduce ? value : 0);
  useEffect(() => {
    if (!inView || reduce) return void setV(value);
    const c = animate(0, value, { duration, ease: EASE_OUT, onUpdate: setV });
    return () => c.stop();
  }, [inView, value, reduce, duration]);
  return <span ref={ref} style={{ fontVariantNumeric: 'tabular-nums' }}>{format(v)}</span>;
}

/** Fraction (0..1) of an element's pass through the viewport, for custom scroll-scrubbed beats. */
export function useScrollFraction<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [f, setF] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const total = r.height - window.innerHeight;
      setF(total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 0);
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(tick); };
    tick();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => { window.removeEventListener('scroll', on); window.removeEventListener('resize', on); cancelAnimationFrame(raf); };
  }, []);
  return [ref, f] as const;
}
