import type { ReactNode } from 'react';
import { Icon } from '../../forest/icons';
import { AgentMark } from '../../forest/AgentMark';

/** Every onboarding step: a small eyebrow, one heading, one lead line, then the step's content. */
export function Shell({ eyebrow, title, lead, children }: { eyebrow: string; title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <div>
      <span className="label">{eyebrow}</span>
      <h1 className="onb-t">{title}</h1>
      <p className="onb-lead dim">{lead}</p>
      <div className="onb-body">{children}</div>
    </div>
  );
}

export interface NextAction {
  label: string;
  icon?: string;
  disabled?: boolean;
  /** Milliseconds until this action runs on its own; the button fills as it counts down. */
  autoMs?: number;
  onClick: (origin: { x: number; y: number }) => void;
}

/** The row under every step: Back on the left; any secondary action, then the primary one, on the right. */
export function Actions({ onBack, backLabel = 'Back', extra, next }: { onBack?: () => void; backLabel?: string; extra?: ReactNode; next?: NextAction }) {
  return (
    <div className="onb-actions">
      {onBack ? (
        <button type="button" className="vbtn vbtn-ghost" onClick={onBack}><Icon name="back" size={15} />{backLabel}</button>
      ) : (
        <span />
      )}
      <div className="onb-actions-r">
        {extra}
        {next && (
          <button
            type="button"
            className="vbtn vbtn-primary onb-next"
            disabled={next.disabled}
            data-auto={next.autoMs ? '' : undefined}
            style={next.autoMs ? ({ '--onb-auto': `${next.autoMs}ms` } as React.CSSProperties) : undefined}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              next.onClick({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
            }}>
            <span>{next.label}</span>
            <Icon name={next.icon ?? 'arrow'} size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

export type StatusTone = 'ok' | 'wait' | 'warn' | 'off';

/** One agent's live state: its mark and name, a dot and a word, and optional detail beneath. */
export function StatusRow({ id, name, tone, status, detail, action, children }: {
  id: string;
  name: string;
  tone: StatusTone;
  status: string;
  detail?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="onb-st" data-tone={tone}>
      <div className="onb-st-h">
        <span className="onb-st-mark"><AgentMark id={id} size={16} /></span>
        <div className="onb-st-t">
          <b>{name}</b>
          {detail && <span className="dim">{detail}</span>}
        </div>
        <span className="onb-st-s"><span className="onb-dot" aria-hidden="true" />{status}</span>
        {action}
      </div>
      {children}
    </li>
  );
}
