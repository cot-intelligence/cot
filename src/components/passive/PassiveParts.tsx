import { useEffect, useState } from 'react';
import {
  previewSchedule,
  type PassiveAgent,
  type PassiveAgentDetail,
  type PassiveRun,
  type PassiveStatus,
} from '../../lib/api';
import { agentLabel } from '../forest/AgentMark';
import { fmt } from '../forest/format';
import { Icon } from '../forest/icons';
import { Agent, Switch } from '../forest/ui';
import { homePath } from '../dashboard/GovernanceView';

/** Matches ACTIVE_WINDOW_MIN in backend/app/passive.py. */
export const ACTIVE_WINDOW_MIN = 10;

const sameDay = (a: string, b: string) => fmt.day(a) === fmt.day(b);
const span = (d: PassiveAgentDetail) => (d.oldest && d.newest ? (sameDay(d.oldest, d.newest) ? fmt.day(d.newest) : `${fmt.day(d.oldest)} – ${fmt.day(d.newest)}`) : null);

/** One line of what's on disk for an agent: the metadata shown before anything is imported. */
export function scanLine(d: PassiveAgentDetail): string {
  if (!d.readable) return 'No transcripts folder the collector can read';
  if (d.transcripts === 0) return 'Folder found, no transcripts yet';
  return [
    `${fmt.n(d.transcripts)} transcript${d.transcripts === 1 ? '' : 's'}`,
    d.projects ? `${fmt.n(d.projects)} project${d.projects === 1 ? '' : 's'}` : null,
    span(d),
    fmt.bytes(d.bytes),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Per-agent on/off with what was found on disk for each. */
export function AgentSources({
  detail,
  enabled,
  onToggle,
  disabled,
}: {
  detail: PassiveAgentDetail[];
  enabled: PassiveAgent[];
  onToggle: (agent: PassiveAgent, on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <ul className="psv-list">
      {detail.map((d) => {
        const on = enabled.includes(d.agent);
        return (
          <li key={d.agent} className="psv-src" data-off={!on || undefined}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Agent id={d.agent} />
                {d.sessions > 0 && <span className="vchip c-dim">{fmt.n(d.sessions)} in cot</span>}
                {d.active > 0 && (
                  <span className="vchip c-info" title={`Written to in the last ${ACTIVE_WINDOW_MIN} minutes`}>
                    {d.active} running now
                  </span>
                )}
              </div>
              <p className="psv-meta mono">{scanLine(d)}</p>
              <p className="psv-path mono faint truncate" title={d.root}>{homePath(d.root)}</p>
            </div>
            <Switch on={on} onChange={(v) => onToggle(d.agent, v)} label={`Import ${agentLabel(d.agent)} transcripts`} disabled={disabled} />
          </li>
        );
      })}
    </ul>
  );
}

/** Plain-English presets, or any five-field cron with a live reading of what it means. */
export function SchedulePicker({
  value,
  presets,
  onChange,
  autoApply,
}: {
  value: string;
  presets: PassiveStatus['presets'];
  onChange: (cron: string) => void;
  /** Apply a valid custom cron as it's typed (onboarding saves later anyway); otherwise a Save button does. */
  autoApply?: boolean;
}) {
  const preset = presets.find((p) => p.cron === value);
  const [custom, setCustom] = useState(!preset);
  const [draft, setDraft] = useState(value);
  const [preview, setPreview] = useState<{ ok: boolean; text: string; next?: string } | null>(null);

  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (!custom) return;
    const t = window.setTimeout(() => {
      previewSchedule(draft)
        .then((r) => {
          setPreview(r.valid ? { ok: true, text: r.description, next: r.next_runs[0] } : { ok: false, text: r.error });
          if (r.valid && autoApply && draft.trim() !== value) onChange(draft.trim());
        })
        .catch(() => setPreview(null));
    }, 250);
    return () => window.clearTimeout(t);
  }, [draft, custom]);

  return (
    <div className="psv-sched">
      <div className="psv-chips" role="radiogroup" aria-label="How often to import">
        {presets.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={!custom && p.cron === value} className="psv-chip" onClick={() => { setCustom(false); onChange(p.cron); }}>
            {p.label}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={custom} className="psv-chip" onClick={() => setCustom(true)}>
          Custom cron
        </button>
      </div>
      {custom && (
        <div className="psv-custom">
          <label className="vfield" style={{ width: '100%' }}>
            <Icon name="clock" size={15} />
            <input
              className="mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="*/20 8-18 * * 1-5"
              aria-label="Cron expression"
              aria-describedby="psv-cron-help"
              spellCheck={false}
              style={{ width: '100%' }}
            />
          </label>
          <p id="psv-cron-help" className="mono faint" style={{ fontSize: 11, margin: '6px 0 0' }}>minute · hour · day of month · month · day of week</p>
          {preview && (
            <p className="psv-preview" data-ok={preview.ok}>
              {preview.ok ? (
                <>
                  <Icon name="check" size={14} /> {preview.text}
                  {preview.next && <span className="faint"> · next {fmt.dayTime(preview.next)}</span>}
                </>
              ) : (
                <>{preview.text}</>
              )}
            </p>
          )}
          {!autoApply && (
            <button type="button" className="vbtn vbtn-quiet vbtn-sm" style={{ marginTop: 10 }} disabled={!preview?.ok || draft.trim() === value} onClick={() => onChange(draft.trim())}>
              Save schedule
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const GAPS: { icon: string; t: string; d: string }[] = [
  { icon: 'pulse', t: 'No live view', d: 'Sessions arrive on your schedule, not as they happen, so there is no "running" state or live trace.' },
  { icon: 'lock', t: 'No permission prompts', d: 'Approvals and denials only reach cot through hooks, so the permission-friction finding never fires.' },
  { icon: 'clock', t: 'Rougher timing for Cursor', d: 'Cursor transcripts carry no per-event times. They are estimated from when the file was written, so durations and slow-command findings are approximate.' },
  { icon: 'bolt', t: 'No lifecycle events', d: 'Session start, end and notification events come from hooks. Imported sessions are marked complete after import.' },
  { icon: 'eye', t: 'Running sessions wait', d: `A session still being written to is left out until it has been quiet for ${ACTIVE_WINDOW_MIN} minutes, then imported whole on the next run.` },
];

/** What transcripts-only mode can't see, next to what it still covers. */
export function HooksGap() {
  return (
    <div className="psv-gap">
      <ul className="psv-gap-l">
        {GAPS.map((g) => (
          <li key={g.t}>
            <span className="psv-gap-ic"><Icon name={g.icon} size={15} /></span>
            <div>
              <b>{g.t}</b>
              <p>{g.d}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="psv-gap-keep">
        <Icon name="check" size={14} /> Still included: prompts, replies, thinking, tool calls and results, files touched, tokens and spend, and most findings.
      </p>
    </div>
  );
}

/** Where the current pass is (metadata, then analysis), or how the last one ended. */
export function RunStatus({ status }: { status: PassiveStatus }) {
  const r = status.running;
  if (r.running) {
    const step = r.phase === 'analysis' ? 1 : 0;
    return (
      <div className="psv-run" role="status" aria-live="polite">
        <ol className="psv-steps">
          <li data-state={step === 0 ? 'now' : 'done'}><span>1</span>Import metadata</li>
          <li data-state={step === 1 ? 'now' : 'todo'}><span>2</span>Run analysis</li>
        </ol>
        <p className="dim" style={{ margin: '8px 0 0', fontSize: 13 }}>
          {step === 0
            ? 'Reading transcripts. Sessions appear in the list as they are imported.'
            : 'Sessions are in. Findings are being computed in the background.'}
        </p>
      </div>
    );
  }
  const last = status.runs[0];
  if (!last) return <p className="dim" style={{ margin: 0, fontSize: 13 }}>No import has run yet.</p>;
  return <LastRun run={last} />;
}

function LastRun({ run }: { run: PassiveRun }) {
  const tone = run.status === 'ok' ? 'c-ok' : run.status === 'partial' ? 'c-warn' : run.status === 'running' ? 'c-info' : 'c-critical';
  const bits = [
    run.new_sessions !== undefined ? `${fmt.n(run.new_sessions)} new session${run.new_sessions === 1 ? '' : 's'}` : null,
    run.events !== undefined ? `${fmt.n(run.events)} events` : null,
    run.findings !== undefined ? `${fmt.n(run.findings)} findings` : null,
    run.held_back ? `${run.held_back} running, next run` : null,
  ].filter(Boolean);
  const errors = Object.entries(run.agents ?? {}).filter(([, a]) => a?.status === 'error');
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className={`vchip ${tone}`}>{run.status === 'ok' ? 'done' : run.status}</span>
        <span className="mono dim" style={{ fontSize: 12 }}>
          {run.trigger === 'schedule' ? 'Scheduled' : 'Manual'} · {fmt.dayTime(run.finished_at ?? run.started_at)}
        </span>
      </div>
      {bits.length > 0 && <p className="mono" style={{ fontSize: 12, margin: '6px 0 0' }}>{bits.join(' · ')}</p>}
      {errors.map(([a, info]) => (
        <p key={a} className="mono" style={{ fontSize: 12, margin: '4px 0 0', color: 'var(--v-alert)' }}>{agentLabel(a)}: {info?.error}</p>
      ))}
      {run.error && <p className="mono" style={{ fontSize: 12, margin: '4px 0 0', color: 'var(--v-alert)' }}>{run.error}</p>}
    </div>
  );
}
