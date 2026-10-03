/* Ported from demo-variants/src/variants/forest/ui.tsx. Class names follow src/forest.css (chip → vchip, seg → vseg). */
import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { AgentMark, agentLabel } from './AgentMark';
import { Icon } from './icons';

export function Wordmark({ size = 22 }: { size?: number }) {
  return <span className="wordmark" style={{ fontSize: size, lineHeight: 1 }}>cot<i>.</i></span>;
}

export type Severity = 'critical' | 'warn' | 'info';
export function Sev({ s }: { s: Severity }) {
  return <span className={`vchip c-${s}`}><span className="dot" />{s}</span>;
}

export function Agent({ id, label = true }: { id: string; label?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <AgentMark id={id} size={13} />
      {label && <span style={{ fontSize: 12 }}>{agentLabel(id)}</span>}
    </span>
  );
}

export function ThemeButton({ theme, toggle }: { theme: string; toggle: () => void }) {
  return (
    <button type="button" className="iconbtn" onClick={toggle} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}

const AGENT_VAR: Record<string, string> = { claude: 'var(--v-claude)', cursor: 'var(--v-cursor)', codex: 'var(--v-codex)', cowork: 'var(--v-cobalt)' };
export const agentColor = (id: string) => AGENT_VAR[id] ?? 'var(--v-faint)';

/** Segmented control with the demo's sliding thumb (a state change, so it animates; a short spring, no bounce). */
export function Seg<K extends string | number>({ value, options, onChange, id }: { value: K; options: { k: K; l: ReactNode }[]; onChange: (k: K) => void; id: string }) {
  return (
    <div className="vseg" role="group">
      {options.map((o) => (
        <button key={String(o.k)} type="button" aria-pressed={value === o.k} onClick={() => onChange(o.k)}>
          {value === o.k && <motion.span layoutId={id} className="thumb" transition={{ type: 'spring', duration: 0.28, bounce: 0 }} />}
          <span>{o.l}</span>
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="vswitch" disabled={disabled} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  );
}
