// Loading placeholders that mirror the eventual layout, so slow loads feel
// instant instead of showing a bare spinner.

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-chip bg-fg/[0.07] ${className}`} />;
}

/** A soft placeholder block in the app's own style: no borders, just a quiet fill. */
function Sk({ w, h, r }: { w: number | string; h: number; r?: number }) {
  return <span className="sk" style={{ display: 'block', width: w, height: h, borderRadius: r }} />;
}

/** Page-level loading state while a view's code arrives: a title, then quiet blocks where the content goes. */
export function MetricsSkeleton() {
  return (
    <div className="scroll" aria-busy="true">
      <div className="page" style={{ display: 'grid', gap: 24 }}>
        <div style={{ display: 'grid', gap: 10 }}>
          <Sk w={70} h={10} />
          <Sk w={260} h={28} />
          <Sk w={340} h={12} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          {[0, 1, 2, 3].map((i) => <Sk key={i} w="100%" h={72} r={12} />)}
        </div>
        <div className="grid-2" style={{ marginTop: 0 }}>
          <Sk w="100%" h={220} r={12} />
          <Sk w="100%" h={220} r={12} />
        </div>
      </div>
    </div>
  );
}

/** Session page loading state: header lines, then timeline rows. */
export function SessionDetailSkeleton() {
  return (
    <div className="scroll" aria-busy="true">
      <div className="page" style={{ display: 'grid', gap: 24 }}>
        <div style={{ display: 'grid', gap: 10 }}>
          <Sk w={90} h={12} />
          <Sk w="55%" h={26} />
          <Sk w={300} h={14} />
        </div>
        <SessionRowsSkeleton />
      </div>
    </div>
  );
}

/** Timeline-shaped rows: an icon dot, a label and a line of text, no frames. */
export function SessionRowsSkeleton({ rows = 7 }: { rows?: number }) {
  const widths = [72, 54, 86, 61, 78, 47, 66];
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '28px 1fr', gap: 14, alignItems: 'start' }}>
          <Sk w={28} h={28} r={8} />
          <div style={{ display: 'grid', gap: 8 }}>
            <Sk w={110} h={10} />
            <Sk w={`${widths[i % widths.length]}%`} h={14} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Skeleton rows for a loading table body. */
export function TableRowsSkeleton({ rows = 6, cols = 8 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-line/10">
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-4 py-3.5">
              <Skeleton className="h-3 w-full" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
