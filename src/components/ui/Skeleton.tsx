// Loading placeholders that mirror the eventual layout, so slow loads feel
// instant instead of showing a bare spinner.

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-sm bg-fg/10 ${className}`} />;
}

/** A bordered "card" of skeleton lines, matching the metrics panels. */
function SkelBlock({ className = '', children }: { className?: string; children?: React.ReactNode }) {
  return <div className={`border border-fg/10 bg-surface/40 p-4 ${className}`}>{children}</div>;
}

export function MetricsSkeleton() {
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-7 px-6 py-8 sm:px-8">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-3 w-80" />
        </div>

        <div className="grid grid-cols-2 gap-px bg-fg/10 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2 bg-bg px-4 py-3">
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-2.5 w-20" />
            </div>
          ))}
        </div>

        {Array.from({ length: 3 }).map((_, s) => (
          <div key={s} className="space-y-3.5">
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-2.5 w-4" />
              <Skeleton className="h-2.5 w-28" />
              <span className="ml-1 h-px flex-1 bg-fg/10" />
            </div>
            <div className="grid gap-px bg-fg/10 md:grid-cols-2">
              <SkelBlock>
                <Skeleton className="h-32 w-full" />
              </SkelBlock>
              <SkelBlock>
                <Skeleton className="h-32 w-full" />
              </SkelBlock>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SessionDetailSkeleton() {
  return (
    <div className="scroll-thin flex-1 overflow-y-auto p-6 sm:p-8">
      <div className="mx-auto max-w-5xl space-y-10">
        <div className="space-y-3">
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-3 w-48" />
          <div className="flex flex-wrap gap-2 pt-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-40" />
            ))}
          </div>
        </div>
        <div className="space-y-5">
          <Skeleton className="h-9 w-56" />
          <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_1fr]">
            <div className="space-y-2 rounded-lg bg-surface p-3 shadow-soft">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
            <div className="rounded-lg bg-surface p-4 shadow-soft">
              <Skeleton className="h-72 w-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Skeleton rows for a loading table body. */
export function TableRowsSkeleton({ rows = 6, cols = 8 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-fg/10">
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
