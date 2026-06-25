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
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-line/10 px-6 py-4 sm:px-8">
        <div className="mx-auto max-w-7xl space-y-2">
          <Skeleton className="h-6 w-96" />
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-64" />
        </div>
      </div>

      {/* Filter bar */}
      <div className="shrink-0 border-b border-line/10 px-6 py-2 sm:px-8">
        <div className="mx-auto flex max-w-7xl items-center gap-2">
          <Skeleton className="h-3 w-24" />
          <div className="ml-auto flex items-center gap-1.5">
            <Skeleton className="h-7 w-16 rounded-full" />
            <Skeleton className="h-7 w-20 rounded-md" />
            <Skeleton className="h-7 w-20 rounded-md" />
          </div>
        </div>
      </div>

      {/* Sidebar + Chat body */}
      <div className="min-h-0 flex-1 px-6 py-3 sm:px-8">
        <div className="mx-auto flex h-full max-w-7xl overflow-hidden rounded-lg border border-line/10">
          {/* Sidebar skeleton */}
          <div className="hidden w-60 shrink-0 space-y-1 border-r border-line/10 p-2 lg:block">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="space-y-1 rounded px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-1.5 w-1.5 rounded-full" />
                  <Skeleton className="h-2 w-14" />
                  <Skeleton className="ml-auto h-2 w-10" />
                </div>
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>

          {/* Chat body skeleton */}
          <div className="min-w-0 flex-1 space-y-3 p-4">
            {/* User prompt */}
            <div className="rounded-lg border border-fg/10 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-2 w-2 rounded-full" />
                <Skeleton className="h-2.5 w-10" />
                <Skeleton className="h-2 w-14" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
            {/* Agent response */}
            <div className="space-y-2 p-4">
              <div className="flex items-center gap-2">
                <Skeleton className="h-2 w-2 rounded-full" />
                <Skeleton className="h-2.5 w-10" />
                <Skeleton className="h-2 w-14" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            {/* Action cards */}
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border border-line/10 px-3.5 py-2.5">
                <Skeleton className="h-1.5 w-1.5 rounded-full" />
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-32" />
                <Skeleton className="ml-auto h-2.5 w-40" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-line/10 px-6 py-1.5 sm:px-8">
        <div className="mx-auto flex max-w-7xl items-center">
          <Skeleton className="h-2.5 w-20" />
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
