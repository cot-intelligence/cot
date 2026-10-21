// Agentic Analysis API (backend/app/analysis.py). A run is a persona's report on
// one session or across sessions, written by cot's agent (BYOK) or by an outside
// agent over cot mcp; both end in deliverables the person can use.

export type AnalysisScope = 'session' | 'across';
export type PersonaKey = 'coach' | 'debugger' | 'cost' | 'security' | 'manager' | 'custom';
export type RunStatus = 'running' | 'ok' | 'error' | 'cancelled';
export type FindingSeverity = 'critical' | 'warn' | 'info';
export type DeliverableKind =
  | 'prompt_rewrite' | 'memory_edit' | 'rule' | 'checklist' | 'root_cause' | 'cost_table'
  | 'config_change' | 'risk_register' | 'summary' | 'task_list';

export interface Persona {
  key: PersonaKey;
  name: string;
  blurb: string;
  outline: string[];
  across_outline: string[];
  deliverables: { kind: DeliverableKind; label: string }[];
  starters: string[];
}

export interface PersonaCatalog {
  personas: Persona[];
  deliverable_kinds: Record<DeliverableKind, { label: string; about: string }>;
}

export interface Evidence {
  event_id: number;
  session_id: string;
}

export interface RunStep {
  kind: 'tool' | 'note';
  tool?: string;
  summary: string;
  ok?: boolean;
  error?: string;
  at: string;
}

export interface ReportSection {
  heading: string;
  body: string;
  evidence: Evidence[];
}

export interface ReportFinding {
  severity: FindingSeverity;
  title: string;
  detail: string;
  evidence: Evidence[];
}

export interface Report {
  title: string;
  summary: string;
  sections: ReportSection[];
  findings: ReportFinding[];
  dropped_findings: number;
}

export interface Deliverable {
  id: string;
  kind: DeliverableKind;
  title: string;
  body: string;
  evidence: Evidence[];
  status: 'new' | 'applied' | 'dismissed';
  before?: string;
  after?: string;
  file?: string;
  append?: string;
  rule_text?: string;
  rule_spec?: Record<string, unknown> | null;
  savings_usd?: number;
  applied?: { rule_id?: string; path?: string; unchanged?: boolean };
}

export interface FollowUp {
  id: string;
  question: string;
  status: RunStatus;
  asked_at: string;
  steps: RunStep[];
  answer?: string;
  points?: string[];
  evidence?: Evidence[];
  error?: string;
}

export interface RunUsage {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  cost_usd?: number | null;
}

export interface AnalysisRun {
  id: string;
  created_at: string;
  updated_at: string;
  scope: AnalysisScope;
  session_id: string | null;
  days: number | null;
  persona: PersonaKey;
  question: string | null;
  status: RunStatus;
  runner: 'cot' | 'agent';
  provider: string | null;
  model: string | null;
  steps: RunStep[] | null;
  report: Report | null;
  deliverables: Deliverable[] | null;
  followups: FollowUp[] | null;
  usage: RunUsage | null;
  error: string | null;
}

export interface RunListItem {
  id: string;
  created_at: string;
  scope: AnalysisScope;
  session_id: string | null;
  days: number | null;
  persona: PersonaKey;
  question: string | null;
  status: RunStatus;
  runner: 'cot' | 'agent';
  provider: string | null;
  model: string | null;
  error: string | null;
  title: string | null;
  summary: string | null;
  findings: number;
  deliverables: number;
  applied: number;
  cost_usd: number | null;
}

export interface AnalysisEstimate {
  configured: boolean;
  disabled: boolean;
  provider: string;
  model: string | null;
  typical_usd: number | null;
  cap_usd: number;
  session: { id: string; title: string | null; events: number | null } | null;
}

/** The collector's own message (FastAPI `detail`) rather than a bare status code. */
async function call<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = await res.json();
      message = typeof body.detail === 'string' ? body.detail : body.detail?.message ?? message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export async function getPersonas(): Promise<PersonaCatalog> {
  return call(await fetch('/v1/analysis/personas'));
}

export async function getEstimate(scope: AnalysisScope, sessionId?: string | null): Promise<AnalysisEstimate> {
  const q = new URLSearchParams({ scope });
  if (sessionId) q.set('session_id', sessionId);
  return call(await fetch(`/v1/analysis/estimate?${q}`));
}

export async function startRun(body: { scope: AnalysisScope; session_id?: string | null; persona: PersonaKey; question?: string; days?: number }): Promise<AnalysisRun> {
  return (await call<{ run: AnalysisRun }>(await post('/v1/analysis/runs', body))).run;
}

export async function listRuns(opts: { sessionId?: string; limit?: number } = {}): Promise<RunListItem[]> {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 60) });
  if (opts.sessionId) q.set('session_id', opts.sessionId);
  return (await call<{ runs: RunListItem[] }>(await fetch(`/v1/analysis/runs?${q}`))).runs;
}

export async function getRun(id: string): Promise<AnalysisRun> {
  return (await call<{ run: AnalysisRun }>(await fetch(`/v1/analysis/runs/${encodeURIComponent(id)}`))).run;
}

export async function deleteRun(id: string): Promise<void> {
  await call(await fetch(`/v1/analysis/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function cancelRun(id: string): Promise<void> {
  await call(await post(`/v1/analysis/runs/${encodeURIComponent(id)}/cancel`));
}

export async function askFollowUp(id: string, question: string): Promise<FollowUp> {
  return (await call<{ followup: FollowUp }>(await post(`/v1/analysis/runs/${encodeURIComponent(id)}/followups`, { question }))).followup;
}

export async function applyDeliverable(id: string, did: string, cwd?: string): Promise<Deliverable> {
  return (await call<{ deliverable: Deliverable }>(await post(`/v1/analysis/runs/${encodeURIComponent(id)}/deliverables/${did}/apply`, { cwd }))).deliverable;
}

export async function setDeliverableStatus(id: string, did: string, status: Deliverable['status']): Promise<Deliverable> {
  return (await call<{ deliverable: Deliverable }>(await post(`/v1/analysis/runs/${encodeURIComponent(id)}/deliverables/${did}/status`, { status }))).deliverable;
}

export const exportUrl = (id: string) => `/v1/analysis/runs/${encodeURIComponent(id)}/export.md`;

export const runHref = (id: string) => `#/analysis/${encodeURIComponent(id)}`;

export const evidenceHref = (e: Evidence) => `#/session/${encodeURIComponent(e.session_id)}?e=${e.event_id}`;

/** The markdown a deliverable copies as: what the person pastes elsewhere. */
export function deliverableText(d: Deliverable): string {
  if (d.kind === 'prompt_rewrite') return d.after ?? d.body;
  if (d.kind === 'memory_edit') return d.append ?? d.body;
  if (d.kind === 'rule') return d.rule_spec ? JSON.stringify(d.rule_spec, null, 2) : d.rule_text ?? d.body;
  return d.body;
}

export const APPLIES: Partial<Record<DeliverableKind, string>> = {
  memory_edit: 'Append to file',
  rule: 'Create rule',
};
