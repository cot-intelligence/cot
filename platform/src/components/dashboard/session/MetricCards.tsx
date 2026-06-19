import type { SessionDetail } from '../../../lib/api';
import { CARD_TAB, metricCardsFor } from '../../../lib/sessionView';
import { Icon } from '../../ui/icons';

interface MetricCardsProps {
  detail: SessionDetail;
  onSelect: (tabKey: string) => void;
}

export function MetricCards({ detail, onSelect }: MetricCardsProps) {
  const cards = metricCardsFor(detail);

  return (
    <div className="flex flex-wrap gap-2">
      {cards.map((card) => {
        const tab = CARD_TAB[card.key];
        return (
          <button
            key={card.key}
            type="button"
            onClick={() => tab && onSelect(tab)}
            disabled={!tab}
            className={`group flex items-center gap-2.5 rounded-md bg-surface px-3 py-2 text-left shadow-soft transition-all ${
              tab ? 'cursor-pointer hover:shadow-soft-md' : 'cursor-default'
            }`}>
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center ${
                card.accent ? 'text-vermilion' : 'text-fg/45 group-hover:text-fg/70'
              }`}>
              <Icon name={card.icon} className="h-4 w-4" />
            </span>
            <span className="font-serif text-xl font-bold tabular-nums leading-none text-fg">
              {card.value}
            </span>
            <span className="font-mono text-[0.65rem] uppercase tracking-widest text-fg/50">
              {card.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
