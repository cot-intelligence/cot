import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { evidenceHref, type Evidence, type PersonaKey, type RunStep } from '../../../lib/analysis';
import { Icon } from '../../forest/icons';

export const PERSONA_ICON: Record<PersonaKey, string> = {
  coach: 'prompt',
  debugger: 'trace',
  cost: 'dollar',
  security: 'lock',
  manager: 'users',
  custom: 'question',
};

export const PERSONA_SHORT: Record<PersonaKey, string> = {
  coach: 'Prompt coach',
  debugger: 'Agent debugger',
  cost: 'Cost optimizer',
  security: 'Security reviewer',
  manager: 'Eng manager',
  custom: 'Custom',
};

const STEP_ICON: Record<string, string> = {
  get_overview: 'overview',
  get_turns: 'sessions',
  get_step: 'file',
  search: 'search',
  get_findings: 'findings',
  get_cost: 'dollar',
  compare_to_baseline: 'pulse',
  list_sessions: 'sessions',
  get_past_analyses: 'archive',
};

// Entering content settles in quickly and never blocks reading (ease-out, under 250ms).
export const RISE = { duration: 0.22, ease: [0.23, 1, 0.32, 1] } as const;

export function Md({ text }: { text: string }) {
  return (
    <div className="an-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target={href?.startsWith('#') ? undefined : '_blank'} rel="noreferrer">{children}</a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Event ids a claim rests on; each opens that step in the session timeline. */
export function EvidenceChips({ evidence, max = 6 }: { evidence: Evidence[]; max?: number }) {
  if (!evidence.length) return null;
  const shown = evidence.slice(0, max);
  return (
    <span className="an-ev" aria-label="Evidence">
      {shown.map((e) => (
        <a key={`${e.session_id}:${e.event_id}`} href={evidenceHref(e)} className="an-evc mono" title="Open this step in the session">
          #{e.event_id}
        </a>
      ))}
      {evidence.length > max && <span className="faint mono" style={{ fontSize: 11 }}>+{evidence.length - max}</span>}
    </span>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="vbtn vbtn-quiet vbtn-sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      <span className="an-swap" data-on={done}>
        <span><Icon name="copy" size={14} />{label}</span>
        <span aria-hidden={!done}><Icon name="check" size={14} />Copied</span>
      </span>
    </button>
  );
}

/** The investigation as it happens: tool calls and the agent's own notes. */
export function StepList({ steps, live }: { steps: RunStep[]; live?: boolean }) {
  const reduce = useReducedMotion();
  return (
    <ol className="an-steps">
      <AnimatePresence initial={false}>
        {steps.map((s, i) => (
          <motion.li
            key={`${i}-${s.at}`}
            className="an-step"
            data-kind={s.kind}
            data-failed={s.ok === false || undefined}
            initial={reduce ? false : { opacity: 0, transform: 'translateY(4px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)' }}
            transition={RISE}
          >
            <span className="an-step-ic">
              <Icon name={s.kind === 'note' ? 'thought' : STEP_ICON[s.tool ?? ''] ?? 'bolt'} size={13} />
            </span>
            <span className={s.kind === 'note' ? 'an-step-note' : 'an-step-t'}>
              {s.summary}
              {s.error && <span className="faint"> · {s.error}</span>}
            </span>
          </motion.li>
        ))}
      </AnimatePresence>
      {live && (
        <li className="an-step" aria-live="polite">
          <span className="an-step-ic an-live"><i /></span>
          <span className="an-step-t dim">Working…</span>
        </li>
      )}
    </ol>
  );
}

export function when(iso: string): string {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dayGroup(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Earlier this week';
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

export function usd(v: number | null | undefined): string | null {
  if (v == null) return null;
  return v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`;
}
