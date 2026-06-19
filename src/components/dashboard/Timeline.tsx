import { useMemo, useState } from 'react';
import type { TimelineItem } from '../../lib/api';
import { ALL_CATEGORIES, getCategoryMeta } from '../../lib/categoryMeta';
import { TimelineItemRow } from './TimelineItem';

interface TimelineProps {
  items: TimelineItem[];
}

export function Timeline({ items }: TimelineProps) {
  const [filter, setFilter] = useState<string | null>(null);

  const categories = useMemo(() => {
    const set = new Set(items.map((i) => i.category));
    return ALL_CATEGORIES.filter((c) => set.has(c));
  }, [items]);

  const filtered = filter ? items.filter((i) => i.category === filter) : items;

  return (
    <div className="space-y-4">
      {categories.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setFilter(null)}
            className={`border px-2 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider transition-colors ${
              filter === null
                ? 'border-fg bg-fg text-bg'
                : 'border-fg/20 text-fg/50 hover:border-fg/40'
            }`}>
            All
          </button>
          {categories.map((cat) => {
            const meta = getCategoryMeta(cat);
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setFilter(cat)}
                className={`border px-2 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider transition-colors ${
                  filter === cat
                    ? 'border-fg bg-fg text-bg'
                    : `border-fg/20 ${meta.color} hover:border-fg/40`
                }`}>
                {meta.label}
              </button>
            );
          })}
        </div>
      )}
      <ol className="border-l border-fg/10 pl-0">
        {filtered.map((item) => (
          <TimelineItemRow key={item.id} item={item} />
        ))}
      </ol>
      {!filtered.length && (
        <p className="font-mono text-xs text-fg/40">No events in this category.</p>
      )}
    </div>
  );
}
