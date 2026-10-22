import type { AgentId } from './agents';

export type EventCategory =
  | 'prompt'
  | 'response'
  | 'thought'
  | 'plan'
  | 'question'
  | 'file_edit'
  | 'file_read'
  | 'context_read'
  | 'shell'
  | 'mcp'
  | 'web'
  | 'subagent'
  | 'memory'
  | 'compaction'
  | 'permission'
  | 'notification'
  | 'lifecycle'
  | 'meta'
  | 'other';

export interface SessionSummary {
  id: string;
  source: AgentId;
  status: string;
  cwd: string | null;
  models: string[];
  archived: boolean;
  bookmarked: boolean;
  started_at: string;
  ended_at: string | null;
  last_activity: string | null;
  event_count: number;
  tool_count: number;
  duration_seconds: number | null;
  title: string | null;
  category_counts: Record<string, number>;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total: number;
  };
  cost_usd: number;
  has_cost: boolean;
  /** Session-level thumbs from its annotation: 1 up, -1 down. */
  rating?: Rating | null;
  /** Session Replay copies only: the id the session had where it was exported. */
  imported_from?: string;
  imported_at?: string | null;
  /** Context typed at import time: why this trace was brought in. */
  import_note?: string | null;
  /** The machine a session imported from another machine's folders ran on (`cot import --from`). */
  machine?: string | null;
  /** Session list only: its kind and active time (events less than five minutes apart). */
  kind?: Archetype;
  active_seconds?: number;
}

export interface TimelineItem {
  id: number;
  /** Deprecated compatibility fields from stored hook rows. */
  hook?: string | null;
  tool: string | null;
  phase?: string | null;
  ts: string;
  source: AgentId;
  category: EventCategory | string;
  title: string;
  detail: string | null;
  target: string | null;
  status: string | null;
  duration_ms: number | null;
  model: string | null;
  attachments: Attachment[] | null;
  start_ts: string;
  end_ts: string | null;
  /** Id of the end event merged into this span; search can return either half. */
  end_id?: number | null;
  ongoing?: boolean;
  payload?: string | null;
  /** True when `detail` is a preview; fetch the full body via getEventDetail. */
  detail_truncated?: boolean;
  /** Self-describing lookup for loading the full body when this row is a preview. */
  detail_lookup?: {
    session_id: string;
    event_id: number;
  };
  /** Set on structured prompt events where the agent asked the user. */
  is_question?: boolean;
  /** Whether a following answer event completed this prompt. */
  answered?: boolean;
  /** Id of the event that answered this prompt (if any). */
  answer_event_id?: number | null;
  /** Set on prompt events that answer a preceding agent prompt. */
  answers_event_id?: number | null;
  /** Sub-questions of a structured-question event, each with its chosen answer. */
  questions?: QuestionPart[];
  /** Cursor composer mode when not the default "agent" (e.g. "plan"). */
  composer_mode?: string;
  /** Session that owns this display row; parent session unless the row was inlined. */
  owner_session_id?: string;
  /** Display provenance for rows inlined from linked sessions. */
  provenance?: 'approval_review' | 'reviewed_session' | 'subagent';
  /** Deprecated aliases for older session-detail callers. */
  event_session_id?: string;
  inlined_approval_review?: boolean;
  inlined_reviewed_session?: boolean;
  inlined_subagent?: boolean;
  subagent_child_session?: string;
  subagent_run_kind?: 'subagent' | 'approval_review';
  /** Backend-owned run membership for rows displayed inside a subagent/review group. */
  run_id?: number;
  run_ids?: number[];
  run_kind?: 'subagent' | 'review';
}

export interface QuestionPart {
  header?: string | null;
  question: string;
  /** Option labels, kept for older readers; `choices` adds descriptions. */
  options?: string[];
  choices?: { label: string; description: string | null }[];
  /** More than one option could be picked. */
  multi?: boolean;
  answer?: string | null;
  /** Labels of the options that were picked. */
  picked?: string[];
  /** A typed answer that isn't one of the options. */
  custom?: string | null;
  note?: string | null;
  skipped?: boolean;
}

export interface Clarification {
  question_event_id: number;
  question_session_id?: string;
  question_ts: string;
  question_excerpt: string;
  answer_event_id: number | null;
  answer_session_id?: string;
  answer_ts: string | null;
  answer_excerpt: string | null;
  answered: boolean;
}

export interface Attachment {
  kind: string;
  media_type: string | null;
  size_bytes?: number;
  width?: number;
  height?: number;
  name?: string;
}

export interface ComponentEntry {
  path?: string;
  target?: string;
  count: number;
}

export interface Components {
  files_edited: ComponentEntry[];
  files_read: ComponentEntry[];
  skills_context: ComponentEntry[];
  mcp_plugins: ComponentEntry[];
  web_calls: ComponentEntry[];
  subagents: ComponentEntry[];
  shell_count: number;
  prompt_count: number;
  response_count: number;
}

export interface SessionLink {
  type: 'approval_review' | 'subagent';
  session_id: string;
  source: AgentId;
  status: string;
  started_at: string;
  last_activity: string | null;
  event_count: number;
  title: string | null;
  label?: string | null;
}

export interface SessionLinks {
  parents: SessionLink[];
  children: SessionLink[];
}

export interface TimelineRun {
  id: number;
  kind: 'subagent' | 'review';
  label: string;
  start: string;
  end: string | null;
  status: string | null;
  duration_ms: number | null;
  ongoing: boolean;
  child_session_id?: string;
  item: TimelineItem;
}

export interface SessionDetail {
  /** Only the opening events; the full read is still to come. */
  partial?: boolean;
  summary: SessionSummary;
  links: SessionLinks;
  components: Components;
  events: TimelineItem[];
  /** Deprecated compatibility field; prefer `events` plus `timeline_runs`. */
  timeline?: TimelineItem[];
  /** Display-ready subagent/review windows assembled by the session read module. */
  timeline_runs: TimelineRun[];
  clarifications: Clarification[];
}

export interface Stats {
  sessions: number;
  events: number;
  tool_calls: number;
  active_sessions: number;
  avg_duration_seconds: number | null;
  by_source: Record<string, number>;
  by_status: Record<string, number>;
  /** Sessions the sessions list shows (top-level, unarchived, with content). */
  listed_sessions: number;
  /** Projects among those sessions. */
  projects: number;
  /** Active, non-info findings as of the last insights pass. */
  open_findings: number;
}

export interface Health {
  status: string;
  version: string;
  db_path: string;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  url: string | null;
}

export interface SessionFilters {
  limit?: number;
  status?: string;
  source?: string;
  q?: string;
  archived?: boolean;
  bookmarked?: boolean;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url} -> ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Which DB a session lives in: traced sessions (`main`) or Session Replay
 * imports (`replay`), which the collector keeps in a separate file.
 */
export type Store = 'main' | 'replay';

/** Append `store=replay` when needed; main-store URLs are unchanged. */
function inStore(url: string, store: Store = 'main'): string {
  if (store === 'main') return url;
  return `${url}${url.includes('?') ? '&' : '?'}store=${store}`;
}

export async function getStats(): Promise<Stats> {
  return json<Stats>(await fetch('/v1/stats'));
}

export async function getHealth(): Promise<Health> {
  return json<Health>(await fetch('/health'));
}

export async function getVersionInfo(refresh = false): Promise<VersionInfo> {
  const query = refresh ? '?refresh=1' : '';
  return json<VersionInfo>(await fetch(`/v1/version${query}`));
}

export type AiProvider = 'anthropic' | 'openai';

export interface Settings {
  /** Stable, anonymous per-install identifier for analytics segregation. */
  install_id: string;
  telemetry_enabled: boolean;
  /** Hard-disabled for this deployment via COT_DISABLE_TELEMETRY. */
  telemetry_env_disabled: boolean;
  telemetry_endpoint: string;
  ai_provider: AiProvider;
  ai_model: string | null;
  ai_default_model: string;
  ai_endpoint: string | null;
  ai_default_endpoint: string;
  ai_effective_endpoint: string;
  ai_configured: boolean;
  /** Shape only (first4+last4); the raw key is never returned. */
  ai_key_masked: string | null;
  ai_key_source: 'env' | 'db' | null;
  /** Hard-disabled for this deployment via COT_DISABLE_LLM. */
  ai_env_disabled: boolean;
  /** Dashboard layout, stored by the collector so it survives any origin. */
  ui_nav_collapsed: boolean;
  ui_sidebar_open: boolean;
  /** Onboarding finished on this install, and the agents picked there. */
  ui_onboarded: boolean;
  ui_onboarding_agents: AgentId[];
  /** The Mac app posts new inbox items as macOS notifications. */
  notify_desktop: boolean;
  /** Read project folders macOS protects (Documents, Desktop, Downloads, iCloud Drive, volumes). */
  read_protected_folders: boolean;
  /** Sessions whose project sits in one of those folders. */
  protected_folder_sessions: number;
}

export async function getSettings(): Promise<Settings> {
  return json<Settings>(await fetch('/v1/settings'));
}

/** ai_api_key is write-only: accepted on PUT, never echoed back. */
export async function updateSettings(
  patch: Partial<Settings> & { ai_api_key?: string },
): Promise<Settings> {
  return json<Settings>(
    await fetch('/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export interface AuditEvent {
  id: number;
  action: string;
  actor: string;
  target: string | null;
  status: string;
  detail: unknown;
  ts: string;
}

export async function getSelfAudit(limit = 100): Promise<AuditEvent[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const data = await json<{ events: AuditEvent[] }>(
    await fetch(`/v1/audit/self?${params.toString()}`),
  );
  return data.events;
}

export interface RetentionPolicy {
  enabled: boolean;
  days: number;
}

export interface RetentionStatus {
  policy: RetentionPolicy;
  cutoff: string;
  oldest_event: string | null;
  eligible_sessions: number;
  eligible_events: number;
  preview_sessions: number;
  preview_events: number;
  db_size_bytes: number;
}

export interface RetentionCleanupResult {
  dry_run: boolean;
  policy: RetentionPolicy;
  cutoff: string;
  eligible_sessions: number;
  eligible_events: number;
  deleted_sessions: number;
  deleted_events: number;
  reclaimed_bytes: number;
}

export async function getRetention(): Promise<RetentionStatus> {
  return json<RetentionStatus>(await fetch('/v1/retention'));
}

export async function updateRetention(patch: Partial<RetentionPolicy>): Promise<RetentionStatus> {
  return json<RetentionStatus>(
    await fetch('/v1/retention', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function cleanupRetention(dryRun = true): Promise<RetentionCleanupResult> {
  return json<RetentionCleanupResult>(
    await fetch('/v1/retention/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: dryRun }),
    }),
  );
}

export interface Metrics {
  totals: {
    sessions: number;
    events: number;
    tool_calls: number;
    active_sessions: number;
    projects: number;
    avg_duration_seconds: number | null;
    errors: number;
    permissions: number;
  };
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total: number;
  };
  by_day: { day: string; events: number }[];
  by_hour: { hour: number; events: number }[];
  by_category: { category: string; events: number }[];
  by_tool: { tool: string; events: number }[];
  cost: {
    total: number;
    by_model: { model: string; tokens: number; cost: number | null }[];
    unpriced_models: string[];
  };
  by_model: {
    model: string;
    events: number;
    output_tokens: number;
    total_tokens: number;
    cost: number | null;
  }[];
  by_source: { source: AgentId; sessions: number; events: number }[];
  by_project: { cwd: string; sessions: number; events: number; last_activity: string | null }[];
  busiest_sessions: { session_id: string; events: number; cwd: string | null }[];
  attachments: {
    total: number;
    prompts_with: number;
    total_bytes: number;
    images: number;
    documents: number;
    by_type: { type: string; count: number }[];
  };
  fun: {
    busiest_day: { day: string; events: number } | null;
    peak_hour: number | null;
    shell_commands: number;
    files_edited: number;
    files_read: number;
    files_touched: number;
    web_calls: number;
    mcp_calls: number;
    prompts: number;
    responses: number;
    thoughts: number;
    top_tool: string | null;
    error_rate: number;
  };
}

/** Overview totals over every session that started in the last `days` days (0 = all time). */
export interface OverviewWindow {
  days: number;
  sessions: number;
  cost: number;
  tools: number;
  oldest: string | null;
  sources: string[];
  series: { day: string; sessions: number; cost: number; tools: number }[];
  projects: { cwd: string | null; sessions: number; cost: number; agents: Record<string, number> }[];
}

/** A project's newest folder as the collector sees it on disk. */
export interface ProjectLocation {
  /** null: a folder macOS guards (Documents, Desktop, Downloads), left unread. */
  exists: boolean | null;
  git?: {
    root: string;
    branch: string | null;
    detached: string | null;
    remote: string | null;
    worktree_of: string | null;
    last_commit: { at: number; subject: string } | null;
  } | null;
  stacks?: string[];
}

/** One row of the projects list: totals in the window, folders, and git details. */
export interface ProjectListItem {
  name: string;
  sessions: number;
  active: number;
  cost: number;
  tools: number;
  agents: Record<string, number>;
  paths: string[];
  first_seen: string | null;
  last_active: string | null;
  location: ProjectLocation;
  /** Commits, pushes and PRs agents made in the window; null when none. */
  shipped?: OutcomeCounts | null;
}

export async function getProjects(days: number): Promise<{ days: number; projects: ProjectListItem[] }> {
  return json(await fetch(`/v1/projects?days=${days}`));
}

/** One project's page: its sessions in a window (0 = all time) and what they did. */
export interface ProjectOverview {
  name: string;
  days: number;
  paths: string[];
  sessions: number;
  active: number;
  cost: number;
  tools: number;
  events: number;
  first_seen: string | null;
  last_active: string | null;
  series: { day: string; sessions: number; cost: number; tools: number }[];
  agents: { source: string; sessions: number; cost: number }[];
  models: { model: string; cost: number | null; tokens: number }[];
  categories: Record<string, number>;
  session_ids: string[];
  recent: SessionSummary[];
}

export async function getProject(name: string, days: number): Promise<ProjectOverview> {
  return json<ProjectOverview>(await fetch(`/v1/projects/${encodeURIComponent(name)}?days=${days}`));
}

export async function getOverviewWindow(days: number): Promise<OverviewWindow> {
  return json<OverviewWindow>(await fetch(`/v1/overview/window?days=${days}`));
}

export async function getMetrics(tz?: string): Promise<Metrics> {
  const params = new URLSearchParams();
  if (tz) params.set('tz', tz);
  const qs = params.toString();
  return json<Metrics>(await fetch(`/v1/metrics${qs ? `?${qs}` : ''}`));
}

export interface MetricsHistoryItem {
  event_id: number;
  session_id: string;
  target: string;
  title: string | null;
  ts: string;
  source: string;
  duration_ms: number | null;
  status: string | null;
  cwd: string | null;
}

export async function getMetricsHistory(
  category: 'shell' | 'web',
  limit = 200,
): Promise<MetricsHistoryItem[]> {
  const params = new URLSearchParams({ category, limit: String(limit) });
  const data = await json<{ items: MetricsHistoryItem[] }>(
    await fetch(`/v1/metrics/history?${params.toString()}`),
  );
  return data.items;
}

// --- Activity (shell, web, MCP calls, skill loads) ---

export type ActivityCategory = 'shell' | 'web' | 'mcp' | 'skill';

export interface ActivityRef {
  session_id: string;
  event_id: number;
  ts: string | null;
}

export interface ActivityError {
  exit_code: number | null;
  message: string | null;
}

export interface ActivityRisk {
  severity: 'critical' | 'warn';
  label: string;
}

export interface ActivityGroup {
  /** Program (shell: `git`, `pytest`, `Grep`) or domain (web). */
  key: string;
  runs: number;
  failed: number;
  /** Runs made with sudo / doas / su (locally or over ssh). */
  elevated: number;
  total_ms: number;
  last: ActivityRef;
  verbs?: { key: string; runs: number }[];
  /** Wrappers this program's runs went through (rtk, sudo, timeout, env…). */
  via?: { key: string; runs: number }[];
  /** Shell: set for Grep/Glob search tools rather than shell programs. */
  tool?: string | null;
  /** Web: localhost / file:// rather than the internet. */
  local?: boolean;
  /** MCP / skills: the extension this group is, for linking to its details page. */
  ext_key?: string;
  plugin?: string | null;
  installed?: boolean;
  /** Set when no config lists it but its source is known, e.g. "Claude app built-in". */
  origin?: string | null;
}

export interface ActivityFailure {
  command: string;
  program?: string | null;
  runs: number;
  failed: number;
  last_error: ActivityError | null;
  last: ActivityRef | null;
}

/** One entry in "Worth a look": an anomaly, a repeated failure, a risky command, or
 *  extensions that sit in every prompt without being used (`idle_overhead`, no ref). */
export interface ActivityAttention {
  kind: 'loop' | 'failure_spike' | 'failing' | 'risky' | 'first_seen' | 'slow' | 'idle_overhead';
  severity: 'critical' | 'warn' | 'info';
  title: string;
  detail: string | null;
  /** The command (or domain) it is about; null for grouped entries. */
  subject: string | null;
  program?: string | null;
  /** Grouped "first time" entries list every name. */
  names?: string[];
  /** The run to open; null when there is none (idle extensions). */
  ref: ActivityRef | null;
}

export interface ActivitySummary {
  category: ActivityCategory;
  days: number;
  summary: {
    runs: number;
    failed: number;
    fail_rate: number;
    total_ms: number;
    sessions: number;
    groups: number;
    risky: number;
    elevated: number;
    local?: number;
    /** MCP: distinct server + tool pairs called. */
    tools?: number;
    /** Skills: loads you started with a /command. */
    slash?: number;
  };
  groups: ActivityGroup[];
  /** Commands that failed at least twice in the window. */
  failing: ActivityFailure[];
  /** One-off failures, most recent first. */
  recent_failures: ActivityFailure[];
  slowest: (ActivityRef & { command: string; duration_ms: number; failed: boolean })[];
  risky: (ActivityRef & { command: string; risk: ActivityRisk })[];
  projects: { cwd: string; runs: number }[];
  sources: { source: string; runs: number }[];
  searches?: { query: string; runs: number }[];
  /** Wrapper counts for the window; `env` covers FOO=1 and env FOO=1. */
  via: { key: string; runs: number }[];
  /** Ranked: anomalies against the history before the window, repeated failures, risky commands. */
  attention: ActivityAttention[];
  /** MCP / skills: plugins whose servers or skills ran in the window, for the plugin filter. */
  plugins?: { key: string; label: string; runs: number }[];
}

export interface ActivityItem {
  event_id: number;
  session_id: string;
  ts: string | null;
  source: string;
  cwd: string | null;
  duration_ms: number | null;
  failed: boolean;
  error: ActivityError | null;
  /** Full command or URL, credentials masked. */
  target: string;
  tool: string | null;
  // shell
  program?: string;
  verb?: string | null;
  /** Command from the statement that does the work (setup like `cd … &&` dropped). */
  core?: string;
  risk?: ActivityRisk | null;
  /** Ran with sudo / doas / su. */
  elevated?: boolean;
  /** Wrappers anywhere in the chain: rtk, rtk proxy, sudo, timeout, nohup, env… */
  via?: string[];
  /** Names (never values) of variables set inline. */
  env_names?: string[];
  /** Exit 1 from grep/rg/diff: the agent logged an error, but it means "no match". */
  no_match?: boolean;
  // web
  key?: string;
  kind?: 'fetch' | 'search';
  local?: boolean;
  // MCP / skills
  ext_key?: string;
  plugin?: string | null;
  path?: string | null;
}

export interface ActivityFilters {
  days: number;
  project?: string;
  source?: string;
  /** MCP / skills: only the servers or skills this plugin ships. */
  plugin?: string;
}

function activityParams(category: ActivityCategory, f: ActivityFilters): URLSearchParams {
  const params = new URLSearchParams({ category, days: String(f.days) });
  if (f.project) params.set('project', f.project);
  if (f.source) params.set('source', f.source);
  if (f.plugin) params.set('plugin', f.plugin);
  return params;
}

export async function getActivity(category: ActivityCategory, f: ActivityFilters): Promise<ActivitySummary> {
  return json<ActivitySummary>(await fetch(`/v1/activity?${activityParams(category, f)}`));
}

export async function getActivityLog(
  category: ActivityCategory,
  f: ActivityFilters & {
    q?: string;
    group?: string;
    failed?: boolean;
    risky?: boolean;
    via?: string;
    offset?: number;
    limit?: number;
  },
): Promise<{ total: number; items: ActivityItem[] }> {
  const params = activityParams(category, f);
  if (f.q) params.set('q', f.q);
  if (f.group) params.set('group', f.group);
  if (f.failed) params.set('failed', 'true');
  if (f.risky) params.set('risky', 'true');
  if (f.via) params.set('via', f.via);
  if (f.offset) params.set('offset', String(f.offset));
  if (f.limit) params.set('limit', String(f.limit));
  return json(await fetch(`/v1/activity/log?${params}`));
}

export type InsightPillar = 'usability' | 'cost' | 'security';
export type InsightSeverity = 'info' | 'warn' | 'critical';
export type InsightStatus = 'active' | 'resolved' | 'dismissed';

export interface InsightEvidence {
  session_id: string;
  event_id: number | null;
  label: string;
  value: string | null;
  ts: string | null;
}

/** A rule-based actionable finding (distinct from the narrative Insight in sessionInsights). */
export interface ActionableInsight {
  id: string;
  fingerprint: string;
  /** Human label for this rule type, used to group like findings in the UI. */
  group_title: string;
  pillar: InsightPillar;
  tier: 1 | 2;
  severity: InsightSeverity;
  title: string;
  detail: string;
  recommendation: string;
  metric: { value: number; unit: string; label: string } | null;
  evidence: InsightEvidence[];
  status: InsightStatus;
  first_seen: string | null;
  last_seen: string | null;
  resolved_at: string | null;
  /** Set while dismissed. */
  dismissed_at?: string | null;
  dismiss_reason?: string | null;
}

export interface InsightsResponse {
  generated_at: string;
  window_days: number;
  insights: ActionableInsight[];
  counts: {
    by_pillar: Record<InsightPillar, number>;
    by_severity: Record<InsightSeverity, number>;
    resolved_recently: number;
  };
}

export async function getInsights(
  days = 30,
  status: InsightStatus | 'all' = 'active',
): Promise<InsightsResponse> {
  const params = new URLSearchParams({ days: String(days), status });
  return json<InsightsResponse>(await fetch(`/v1/insights?${params.toString()}`));
}

export async function getSessionInsights(
  sessionId: string,
  store: Store = 'main',
): Promise<InsightsResponse> {
  return json<InsightsResponse>(
    await fetch(inStore(`/v1/sessions/${encodeURIComponent(sessionId)}/insights`, store)),
  );
}

export interface InboxItem {
  id: number;
  kind: string;
  severity: 'critical' | 'warn' | 'info' | null;
  title: string;
  body: string | null;
  href: string | null;
  created_at: string;
  read_at: string | null;
}

export interface Inbox {
  items: InboxItem[];
  unread: number;
  latest_id: number;
  notify_desktop: boolean;
}

export async function getInbox(limit = 8): Promise<Inbox> {
  return json<Inbox>(await fetch(`/v1/notifications?limit=${limit}`));
}

/** Mark some notifications (or all, with no ids) read; resolves to the unread count left. */
export async function markInboxRead(ids?: number[]): Promise<number> {
  const res = await json<{ unread: number }>(
    await fetch('/v1/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids ?? null }),
    }),
  );
  return res.unread;
}

/** Dismiss a finding, optionally saying why (kept with it, cleared on reopen). */
export async function dismissInsight(fingerprint: string, reason?: string): Promise<void> {
  await json<{ ok: boolean }>(
    await fetch(`/v1/insights/${encodeURIComponent(fingerprint)}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason?.trim() || null }),
    }),
  );
}

export async function restoreInsight(fingerprint: string): Promise<void> {
  await json<{ ok: boolean }>(
    await fetch(`/v1/insights/${encodeURIComponent(fingerprint)}/restore`, { method: 'POST' }),
  );
}

export interface AiInsightItem {
  title: string;
  detail: string;
  recommendation: string;
  severity: InsightSeverity;
}

export interface AiAnalysisResult {
  summary: string;
  sections: {
    usage: AiInsightItem[];
    security: AiInsightItem[];
    cost: AiInsightItem[];
  };
}

export interface AiAnalysis {
  id: number;
  created_at: string;
  provider: AiProvider;
  model: string;
  window_days: number;
  input_summary: { findings: number; excerpts: number; payload_bytes: number } | null;
  result: AiAnalysisResult | null;
  status: 'ok' | 'error';
  error: string | null;
}

/** Explicit BYOK analysis — costs the user provider credits; never polled. */
export async function runAiAnalysis(days = 30): Promise<AiAnalysis> {
  const res = await fetch('/v1/insights/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    // Surface the backend's error detail (bad key, provider failure) verbatim.
    let detail = `analysis failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* keep fallback */
    }
    throw new Error(detail);
  }
  const data = (await res.json()) as { analysis: AiAnalysis };
  return data.analysis;
}

export async function getAiAnalyses(limit = 10): Promise<AiAnalysis[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const data = await json<{ analyses: AiAnalysis[] }>(
    await fetch(`/v1/insights/analyses?${params.toString()}`),
  );
  return data.analyses;
}

export interface Connection {
  source: AgentId;
  sessions: number;
  events: number;
  last_event: string | null;
  connected: boolean;
}

export async function getConnections(): Promise<Connection[]> {
  const data = await json<{ connections: Connection[] }>(await fetch('/v1/connections'));
  return data.connections;
}

export type HookHealthState =
  | 'healthy'
  | 'missing_hooks'
  | 'not_installed'
  | 'stale'
  | 'no_events';

export interface HookBackup {
  agent: AgentId;
  config_path: string;
  backup_path: string;
  created_at: string;
  action: string;
  endpoint: string;
}

export interface HookStatusAgent {
  source: AgentId;
  installed: boolean;
  connected: boolean;
  sessions: number;
  events: number;
  last_event: string | null;
  config_path: string | null;
  config_exists: boolean | null;
  valid_json: boolean | null;
  expected_hooks: string[];
  installed_hooks: string[];
  missing_hooks: string[];
  labels: string[];
  installed_labels: string[];
  missing_labels: string[];
  backup_count: number;
  latest_backup: HookBackup | null;
  warnings: string[];
  health: HookHealthState;
  repair_url: string;
}

export interface HookStatus {
  updated_at: string | null;
  endpoint: string | null;
  manifest_found: boolean;
  repair_all_url: string;
  agents: HookStatusAgent[];
}

export async function getHookStatus(): Promise<HookStatus> {
  return json<HookStatus>(await fetch('/v1/hooks/status'));
}

export async function getSessions(filters: SessionFilters = {}): Promise<SessionSummary[]> {
  const params = new URLSearchParams();
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.status) params.set('status', filters.status);
  if (filters.source) params.set('source', filters.source);
  if (filters.q) params.set('q', filters.q);
  if (filters.archived) params.set('archived', 'true');
  if (filters.bookmarked) params.set('bookmarked', 'true');
  const qs = params.toString();
  const data = await json<{ sessions: SessionSummary[] }>(
    await fetch(`/v1/sessions${qs ? `?${qs}` : ''}`),
  );
  return data.sessions;
}

export type SessionSort = 'recent' | 'events' | 'duration' | 'cost';

export interface SessionPageQuery extends SessionFilters {
  offset?: number;
  /** Last path segment of the working directory, as the dashboard names projects. */
  project?: string;
  /** Only these sessions (the "with findings" filter). An empty list matches nothing. */
  ids?: string[];
  sort?: SessionSort;
  order?: 'asc' | 'desc';
  /** One session kind, judged on active time against the user's own history. */
  kind?: Archetype;
}

export interface SessionPage {
  sessions: SessionSummary[];
  total: number;
  has_more: boolean;
  /** Older collector: only its newest 500 sessions were searched, so there may be more. */
  capped?: boolean;
}

/** One page of the sessions list, filtered and sorted by the collector, plus the total. */
export async function getSessionsPage(f: SessionPageQuery): Promise<SessionPage> {
  const params = new URLSearchParams();
  if (f.limit) params.set('limit', String(f.limit));
  if (f.offset) params.set('offset', String(f.offset));
  if (f.status) params.set('status', f.status);
  if (f.source) params.set('source', f.source);
  if (f.q) params.set('q', f.q);
  if (f.project) params.set('project', f.project);
  if (f.ids) params.set('ids', f.ids.join(','));
  if (f.sort && f.sort !== 'recent') params.set('sort', f.sort);
  if (f.order === 'asc') params.set('order', 'asc');
  if (f.archived) params.set('archived', 'true');
  if (f.bookmarked) params.set('bookmarked', 'true');
  if (f.kind) params.set('kind', f.kind);
  const page = await json<Partial<SessionPage> & { sessions: SessionSummary[] }>(await fetch(`/v1/sessions?${params.toString()}`));
  if (typeof page.total === 'number') return page as SessionPage;
  return legacySessionsPage(f);
}

const LEGACY_LIMIT = 500;

/** Collectors from before server-side paging ignore offset/project/ids/sort and send no total:
 *  take their newest 500 and page, filter and sort them here instead. */
async function legacySessionsPage(f: SessionPageQuery): Promise<SessionPage> {
  const all = await getSessions({ limit: LEGACY_LIMIT, status: f.status, source: f.source, q: f.q, archived: f.archived, bookmarked: f.bookmarked });
  const projectOf = (cwd: string | null) => cwd?.split('/').filter(Boolean).pop() ?? '';
  const ids = f.ids ? new Set(f.ids) : null;
  const q = f.q?.toLowerCase();
  const rows = all.filter(
    (s) =>
      (!f.project || projectOf(s.cwd) === f.project) &&
      (!ids || ids.has(s.id)) &&
      // Old collectors don't search titles; match them here too.
      (!q || s.id.toLowerCase().includes(q) || (s.cwd ?? '').toLowerCase().includes(q) || (s.title ?? '').toLowerCase().includes(q)),
  );
  const val = (s: SessionSummary) =>
    f.sort === 'events' ? s.event_count : f.sort === 'duration' ? s.duration_seconds ?? 0 : f.sort === 'cost' ? s.cost_usd : new Date(s.last_activity ?? s.started_at).getTime();
  rows.sort((a, b) => (f.order === 'asc' ? val(a) - val(b) : val(b) - val(a)));
  const offset = f.offset ?? 0;
  const limit = f.limit ?? 20;
  return { sessions: rows.slice(offset, offset + limit), total: rows.length, has_more: offset + limit < rows.length, capped: all.length >= LEGACY_LIMIT && rows.length === all.length };
}

/** Every project name with its session count, for the Sessions project filter. */
export async function getSessionProjects(archived = false): Promise<{ project: string; sessions: number }[]> {
  const res = await fetch(`/v1/sessions/projects${archived ? '?archived=true' : ''}`);
  if (res.ok) return (await json<{ projects: { project: string; sessions: number }[] }>(res)).projects;
  // Older collectors have no project list (the request falls through to a session lookup): count from the recent sessions.
  const counts = new Map<string, number>();
  for (const x of await getSessions({ limit: LEGACY_LIMIT, archived })) {
    const name = x.cwd?.split('/').filter(Boolean).pop();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([project, sessions]) => ({ project, sessions })).sort((a, b) => a.project.localeCompare(b.project));
}

/** `first` asks for only the opening events (`partial` is set when there are more). */
export async function getSessionDetail(id: string, store: Store = 'main', first?: number): Promise<SessionDetail> {
  return json<SessionDetail>(await fetch(inStore(`/v1/sessions/${id}${first ? `?first=${first}` : ''}`, store)));
}

export interface EventDetail {
  id: number;
  detail: string | null;
  attachments: Attachment[] | null;
}

/** Full detail body for one event, fetched on demand when its list entry was
 * truncated (keeps the session list payload small). */
export async function getEventDetail(
  sessionId: string,
  eventId: number,
  store: Store = 'main',
): Promise<EventDetail> {
  return json<EventDetail>(await fetch(inStore(`/v1/sessions/${sessionId}/events/${eventId}`, store)));
}

export async function setSessionArchived(id: string, archived: boolean): Promise<void> {
  const action = archived ? 'archive' : 'unarchive';
  await json(await fetch(`/v1/sessions/${id}/${action}`, { method: 'POST' }));
}

export async function setSessionBookmarked(id: string, bookmarked: boolean): Promise<void> {
  const action = bookmarked ? 'bookmark' : 'unbookmark';
  await json(await fetch(`/v1/sessions/${id}/${action}`, { method: 'POST' }));
}

export type Rating = 1 | -1;

/** What the person thought of a session (`event_id` null) or one event in it. */
export interface Annotation {
  session_id: string;
  event_id: number | null;
  rating: Rating | null;
  labels: string[];
  note: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SessionAnnotations {
  session: Annotation | null;
  events: Annotation[];
}

export async function getSessionAnnotations(sessionId: string): Promise<SessionAnnotations> {
  return json<SessionAnnotations>(await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/annotations`));
}

/** Replaces the annotation; no rating, labels or note clears it. */
export async function putAnnotation(
  sessionId: string,
  body: { event_id?: number | null; rating: Rating | null; labels: string[]; note: string | null },
): Promise<Annotation> {
  return json<Annotation>(
    await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/annotations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Downloads the whole session (untrimmed events, raw hook rows) as JSON. */
export function sessionExportUrl(id: string, store: Store = 'main', format: 'json' | 'md' | 'html' = 'json'): string {
  const url = `/v1/sessions/${encodeURIComponent(id)}/export`;
  return inStore(format === 'json' ? url : `${url}?format=${format}`, store);
}

/** Imported sessions, newest import first (one row per imported file). */
export async function getReplaySessions(): Promise<SessionSummary[]> {
  const data = await json<{ sessions: SessionSummary[] }>(
    await fetch(inStore('/v1/sessions?limit=500', 'replay')),
  );
  return data.sessions.sort((a, b) => (b.imported_at ?? '').localeCompare(a.imported_at ?? ''));
}

export interface ReplayImportResult {
  session_id: string;
  sessions: number;
  events: number;
}

/** Import a session export file into Session Replay. Rejects with the collector's reason. */
export async function importReplaySession(file: File): Promise<ReplayImportResult> {
  const res = await fetch('/v1/replay/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: file,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Import failed (${res.status})`);
  }
  return (await res.json()) as ReplayImportResult;
}

/** Set (or clear, with an empty string) the context note on a Session Replay import. */
export async function setImportNote(id: string, note: string): Promise<void> {
  await json(
    await fetch(inStore(`/v1/sessions/${encodeURIComponent(id)}/import-note`, 'replay'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    }),
  );
}

/** Delete an imported session, with every session its file brought along. */
export async function deleteReplaySession(id: string): Promise<void> {
  await json(await fetch(inStore(`/v1/sessions/${encodeURIComponent(id)}`, 'replay'), { method: 'DELETE' }));
}

export interface SearchResult {
  session_id: string;
  event_id: number;
  category: EventCategory | string;
  title: string | null;
  target: string | null;
  ts: string;
  source: AgentId;
  model: string | null;
  cwd: string | null;
  snippet: string;
}

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export async function search(
  q: string,
  limit = 40,
  sessionId?: string,
  store: Store = 'main',
  mode: SearchMode = 'keyword',
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (sessionId) params.set('session_id', sessionId);
  if (mode !== 'keyword') params.set('mode', mode);
  const data = await json<{ results: SearchResult[] }>(
    await fetch(inStore(`/v1/search?${params.toString()}`, store)),
  );
  return data.results;
}

export interface ImportSummary {
  sessions: number;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total: number;
  };
  earliest: string | null;
  latest: string | null;
  by_source: { source: string; sessions: number; events: number }[];
}

export type ExportInclude = 'events' | 'components' | 'conversation' | 'clarifications';

export interface ExportFilters {
  session_ids?: string[];
  source?: string;
  cwd?: string;
  models?: string[];
  started_after?: string;
  started_before?: string;
  ended_after?: string;
  ended_before?: string;
  status?: string;
  min_tokens?: number;
  min_cost?: number;
  min_events?: number;
  fields?: string[];
  include?: ExportInclude[];
  limit?: number;
}

export interface ExportResult {
  sessions: Record<string, unknown>[];
  count: number;
}

export async function exportSessions(filters: ExportFilters): Promise<ExportResult> {
  return json<ExportResult>(
    await fetch('/v1/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(filters),
    }),
  );
}

export async function getImportSummary(): Promise<ImportSummary> {
  return json<ImportSummary>(await fetch('/v1/import/summary'));
}

async function ingest(source: AgentId, payload: Record<string, unknown>) {
  await fetch(`/v1/ingest/${source}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Full realistic session for demo + automated tests. */
export async function sendTestEvent(source: AgentId): Promise<string> {
  const sid = `sess_${crypto.randomUUID().replace(/-/g, '').slice(0, 7)}`;
  const cwd = '/Users/dev/cot-demo';
  const ts = () => new Date().toISOString();

  if (source === 'claude') {
    const base = { session_id: sid, cwd };
    const events: Record<string, unknown>[] = [
      { hook_event_name: 'SessionStart', timestamp: ts() },
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Refactor the parser and add tests. Read CLAUDE.md first.',
        timestamp: ts(),
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'CLAUDE.md' },
        timestamp: ts(),
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'CLAUDE.md' },
        tool_response: '# Project rules\nUse pytest. Keep diffs small.',
        duration_ms: 42,
        timestamp: ts(),
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__playwright__browser_navigate',
        tool_input: { url: 'https://docs.example.com/api' },
        timestamp: ts(),
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__playwright__browser_navigate',
        tool_input: { url: 'https://docs.example.com/api' },
        tool_response: { status: 200, title: 'API Reference' },
        duration_ms: 890,
        timestamp: ts(),
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'WebFetch',
        tool_input: { url: 'https://api.example.com/v1/status' },
        timestamp: ts(),
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'WebFetch',
        tool_input: { url: 'https://api.example.com/v1/status' },
        tool_response: '{"ok":true,"version":"2.1.0"}',
        duration_ms: 310,
        timestamp: ts(),
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/parser.ts',
          old_string: 'function parse()',
          new_string: 'function parse(input: string)',
        },
        timestamp: ts(),
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/parser.ts' },
        tool_response: 'Applied edit',
        duration_ms: 55,
        timestamp: ts(),
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pytest tests/test_parser.py -q' },
        timestamp: ts(),
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pytest tests/test_parser.py -q' },
        tool_response: '3 passed in 0.41s',
        duration_ms: 410,
        timestamp: ts(),
      },
      {
        hook_event_name: 'afterAgentResponse',
        response:
          'Refactored parser.ts with typed input. All 3 tests pass. MCP playwright fetched docs; web status returned 2.1.0.',
        _synthetic_category: 'response',
        timestamp: ts(),
      },
      { hook_event_name: 'Stop', timestamp: ts() },
      { hook_event_name: 'SessionEnd', timestamp: ts() },
    ];
    for (const ev of events) {
      await ingest('claude', { ...base, ...ev });
    }
  } else if (source === 'codex') {
    const base = { session_id: sid, cwd, model: 'gpt-5.5-codex' };
    const patch =
      '*** Begin Patch\n*** Update File: src/parser.ts\n@@\n-function parse()\n+function parse(input: string)\n*** End Patch';
    const events: Record<string, unknown>[] = [
      { hook_event_name: 'SessionStart', source: 'startup', timestamp: ts() },
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Refactor the parser and run the tests.',
        timestamp: ts(),
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pytest tests/test_parser.py -q' },
        timestamp: ts(),
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pytest tests/test_parser.py -q' },
        tool_response: '3 passed in 0.39s',
        duration_ms: 390,
        timestamp: ts(),
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: patch },
        timestamp: ts(),
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: patch },
        tool_response: 'Applied patch to src/parser.ts',
        duration_ms: 48,
        timestamp: ts(),
      },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__linear__create_issue',
        tool_input: { title: 'Type the parser input', team: 'ENG' },
        timestamp: ts(),
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__linear__create_issue',
        tool_input: { title: 'Type the parser input', team: 'ENG' },
        tool_response: { id: 'LIN-517', url: 'https://linear.app/issue/LIN-517' },
        duration_ms: 540,
        timestamp: ts(),
      },
      {
        hook_event_name: 'afterAgentResponse',
        response: 'Typed parser input, applied the patch, and all 3 tests pass. Filed LIN-517.',
        _synthetic_category: 'response',
        timestamp: ts(),
      },
      {
        hook_event_name: 'Stop',
        last_assistant_message:
          'Typed parser input, applied the patch, and all 3 tests pass. Filed LIN-517.',
        timestamp: ts(),
      },
    ];
    for (const ev of events) {
      await ingest('codex', { ...base, ...ev });
    }
  } else if (source === 'opencode') {
    const base = { session_id: sid, cwd, model: 'openai/gpt-5' };
    const events: Record<string, unknown>[] = [
      { hook_event_name: 'SessionStart', timestamp: ts() },
      { hook_event_name: 'UserPromptSubmit', prompt: 'Inspect the parser and fix the failing test.', timestamp: ts() },
      { hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'npm test' }, timestamp: ts() },
      { hook_event_name: 'PostToolUse', tool_name: 'bash', tool_input: { command: 'npm test' }, tool_response: 'Tests passed', timestamp: ts() },
      { hook_event_name: 'afterAgentResponse', response: 'The parser test now passes.', timestamp: ts() },
      { hook_event_name: 'OpenCodeUsage', usage: { input_tokens: 120, output_tokens: 40 }, timestamp: ts() },
      { hook_event_name: 'Stop', timestamp: ts() },
    ];
    for (const ev of events) await ingest('opencode', { ...base, ...ev });
  } else if (source === 'hermes') {
    const base = { session_id: sid, cwd, model: 'hermes-4-405b' };
    const events: Record<string, unknown>[] = [
      { hook_event_name: 'SessionStart', platform: 'cli', timestamp: ts() },
      { hook_event_name: 'UserPromptSubmit', prompt: 'Inspect the parser and fix the failing test.', timestamp: ts() },
      { hook_event_name: 'PostToolUse', tool_name: 'terminal', tool_input: { command: 'npm test' }, tool_response: '{"output": "Tests passed", "exit_code": 0}', timestamp: ts() },
      { hook_event_name: 'afterAgentResponse', response: 'The parser test now passes.', timestamp: ts() },
      { hook_event_name: 'ModelUsage', usage: { input_tokens: 120, output_tokens: 40 }, timestamp: ts() },
      { hook_event_name: 'Stop', completed: true, timestamp: ts() },
    ];
    for (const ev of events) await ingest('hermes', { ...base, ...ev });
  } else {
    const base = { conversation_id: sid, workspace_roots: [cwd], cwd };
    const events: Record<string, unknown>[] = [
      { hook_event_name: 'sessionStart', timestamp: ts() },
      {
        hook_event_name: 'beforeSubmitPrompt',
        prompt: 'Wire up hooks and trace every MCP call.',
        timestamp: ts(),
      },
      {
        hook_event_name: 'beforeReadFile',
        file_path: '.cursor/rules/cot.mdc',
        timestamp: ts(),
      },
      {
        hook_event_name: 'beforeMCPExecution',
        server: 'linear',
        tool_name: 'create_issue',
        arguments: { title: 'Add session timeline', team: 'ENG' },
        timestamp: ts(),
      },
      {
        hook_event_name: 'afterMCPExecution',
        server: 'linear',
        tool_name: 'create_issue',
        result: { id: 'LIN-482', url: 'https://linear.app/issue/LIN-482' },
        duration_ms: 620,
        timestamp: ts(),
      },
      {
        hook_event_name: 'beforeShellExecution',
        command: 'npm run build',
        timestamp: ts(),
      },
      {
        hook_event_name: 'afterShellExecution',
        command: 'npm run build',
        output: 'built in 1.2s',
        duration_ms: 1200,
        timestamp: ts(),
      },
      {
        hook_event_name: 'afterFileEdit',
        file_path: 'src/lib/api.ts',
        edits: [{ file_path: 'src/lib/api.ts', old_string: 'limit=10', new_string: 'limit=50' }],
        timestamp: ts(),
      },
      {
        hook_event_name: 'afterAgentThought',
        thought: 'Need to add timeline types and poll the session detail endpoint.',
        timestamp: ts(),
      },
      {
        hook_event_name: 'afterAgentResponse',
        response: 'Timeline API wired. MCP linear issue LIN-482 created. Build passed.',
        timestamp: ts(),
      },
      { hook_event_name: 'subagentStart', subagent_type: 'explore', timestamp: ts() },
      { hook_event_name: 'subagentStop', subagent_type: 'explore', timestamp: ts() },
      { hook_event_name: 'stop', timestamp: ts() },
      { hook_event_name: 'sessionEnd', timestamp: ts() },
    ];
    for (const ev of events) {
      await ingest('cursor', { ...base, ...ev });
    }
  }
  return sid;
}

// ---------------------------------------------------------------- passive mode

/** An agent passive import can read: the bridge's reader registry, so the
 *  hook agents plus every agent read from its files on disk. */
export type PassiveAgent = 'claude' | 'cursor' | 'codex' | 'opencode' | 'hermes' | (string & {});

/** What's on disk for one agent (a scan, nothing imported) plus sessions already in cot. */
export interface PassiveAgentDetail {
  agent: PassiveAgent;
  root: string;
  readable: boolean;
  transcripts: number;
  bytes: number;
  projects: number;
  oldest: string | null;
  newest: string | null;
  /** Transcripts written to in the last few minutes: sessions still running, left for the next run. */
  active: number;
  sessions: number;
  /** Every folder read for this agent: its default ones and any extra homes. */
  roots?: string[];
  /** Extra data folders added for this agent, as stored (``~/…``). */
  extra_homes?: string[];
}

export interface PassiveRunAgent {
  status: 'ok' | 'error' | 'unreadable' | 'skipped' | 'importing';
  events?: number;
  held_back?: number;
  error?: string;
  files_done?: number;
  files_total?: number;
}

/** Enrichment (analysis) steps done: snapshot, each rule, reconcile. */
export interface PassiveAnalysis {
  done: number;
  total: number;
}

/** Import progress across every agent in the run, by bytes of transcript read. */
export interface PassiveProgress {
  bytes_done: number;
  bytes_total: number;
  agent: PassiveAgent;
}

export interface PassiveRun {
  id: number;
  trigger: 'manual' | 'schedule' | string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'ok' | 'partial' | 'error';
  phase?: 'metadata' | 'analysis' | 'done';
  agents?: Partial<Record<PassiveAgent, PassiveRunAgent>>;
  events?: number;
  new_sessions?: number;
  held_back?: number;
  findings?: number;
  error?: string;
}

export interface PassiveSchedule {
  cron: string;
  description: string;
  next_runs: string[];
}

export interface PassiveStatus {
  enabled: boolean;
  agents: PassiveAgent[];
  cron: string;
  schedule: PassiveSchedule;
  next_scheduled: string | null;
  running: { running: boolean; phase?: 'metadata' | 'analysis'; started_at?: string; trigger?: string; agents?: Partial<Record<PassiveAgent, PassiveRunAgent>>; progress?: PassiveProgress; analysis?: PassiveAnalysis };
  agents_detail: PassiveAgentDetail[];
  runs: PassiveRun[];
  presets: { id: string; label: string; cron: string }[];
}

/** Thrown when the collector predates passive mode (no /v1/passive): the app needs updating. */
export class PassiveUnsupportedError extends Error {
  constructor() {
    super('This collector does not support passive import yet');
  }
}

export async function getPassive(): Promise<PassiveStatus> {
  const res = await fetch('/v1/passive');
  if (res.status === 404) throw new PassiveUnsupportedError();
  return json<PassiveStatus>(res);
}

export async function updatePassive(patch: { enabled?: boolean; agents?: PassiveAgent[]; cron?: string }): Promise<PassiveStatus> {
  const res = await fetch('/v1/passive', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Couldn't save (${res.status})`);
  }
  return (await res.json()) as PassiveStatus;
}

async function passiveHome(method: 'POST' | 'DELETE', agent: PassiveAgent, path: string): Promise<PassiveStatus> {
  const res = await fetch('/v1/passive/homes', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, path }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail || `Couldn't save (${res.status})`);
  }
  return (await res.json()) as PassiveStatus;
}

/** Read another data folder for an agent too (a custom CLAUDE_CONFIG_DIR, CODEX_HOME …). */
export const addPassiveHome = (agent: PassiveAgent, path: string) => passiveHome('POST', agent, path);
export const removePassiveHome = (agent: PassiveAgent, path: string) => passiveHome('DELETE', agent, path);

export async function previewSchedule(cron: string): Promise<({ valid: true } & PassiveSchedule) | { valid: false; error: string }> {
  return json(
    await fetch('/v1/passive/schedule/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron }),
    }),
  );
}

export async function runPassiveNow(): Promise<{ started: boolean }> {
  return json(await fetch('/v1/passive/run', { method: 'POST' }));
}

/** Light progress check (no transcript scan) for the dashboard banner. */
export async function getPassiveRunning(): Promise<{ running: PassiveStatus['running']; last_run: PassiveRun | null }> {
  return json(await fetch('/v1/passive/running'));
}

/** Sessions on disk that cot hasn't imported yet (enabled agents only). */
export interface PassivePending {
  total: number;
  by_agent: Partial<Record<PassiveAgent, number>>;
  newest: string | null;
}

export async function getPassivePending(fresh = false): Promise<PassivePending> {
  return json(await fetch(`/v1/passive/pending${fresh ? '?fresh=1' : ''}`));
}

export interface PassiveHistoryRun {
  id: number;
  trigger: string;
  status: PassiveRun['status'];
  started_at: string;
  finished_at: string | null;
  new_sessions?: number | null;
  events?: number | null;
  findings?: number | null;
}

/** Import runs over the last `days` (the collector keeps 30). */
export async function getPassiveHistory(days = 30): Promise<{ days: number; runs: PassiveHistoryRun[] }> {
  return json(await fetch(`/v1/passive/history?days=${days}`));
}

// ---------------------------------------------------------------- attachments

export interface AttachmentRow extends Attachment {
  session_id: string;
  event_id: number;
  index: number;
  ts: string;
  cwd: string | null;
  source: AgentId;
  extension: string | null;
  path: string | null;
}

export async function getAttachments(limit = 500): Promise<AttachmentRow[]> {
  const data = await json<{ attachments: AttachmentRow[] }>(await fetch(`/v1/attachments?limit=${limit}`));
  return data.attachments;
}

/** Permanently delete a traced session and its subagent sessions. */
export async function deleteSession(id: string): Promise<void> {
  await json(await fetch(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

// ----------------------------------------------------------------- task tray

export type TaskRunning =
  | { id: string; kind: 'session'; session_id: string; title: string; source: string; cwd: string | null; events: number; started_at: string; last_activity: string | null }
  | { id: string; kind: 'passive'; phase: 'metadata' | 'analysis'; trigger?: string; started_at?: string; progress?: PassiveProgress | null; analysis?: PassiveAnalysis | null }
  | { id: string; kind: 'index'; title: string };

export interface TaskRecent {
  id: string;
  kind: 'passive';
  status: 'ok' | 'partial' | 'error';
  finished_at: string;
  trigger: string;
  new_sessions: number;
  findings?: number;
  held_back: number;
  error?: string;
}

/** In-progress work for the top-bar tray, plus passive runs that finished in the last day.
 *  Collectors from before /v1/tasks still report live sessions through the sessions list. */
export async function getTasks(): Promise<{ running: TaskRunning[]; recent: TaskRecent[] }> {
  const res = await fetch('/v1/tasks');
  if (res.status !== 404) return json(res);
  const live = await getSessions({ limit: 20, status: 'active' });
  return {
    running: live.map((x) => ({
      id: `session:${x.id}`,
      kind: 'session' as const,
      session_id: x.id,
      title: x.title || 'Untitled session',
      source: x.source,
      cwd: x.cwd,
      events: x.event_count,
      started_at: x.started_at,
      last_activity: x.last_activity ?? null,
    })),
    recent: [],
  };
}

// --- Extensions (plugins, skills, MCP servers) ------------------------------

export type ExtensionKind = 'plugin' | 'skill' | 'mcp';
export type ExtensionScope = 'user' | 'project' | 'local' | 'plugin' | 'builtin' | 'managed' | 'desktop';
export type RiskLevel = 'ok' | 'low' | 'medium' | 'high' | 'critical' | null;

export interface ExtensionUsage {
  sessions: number;
  calls: number;
  errors: number;
  error_rate: number;
  p50_ms: number | null;
  first_used: string | null;
  last_used: string | null;
  agents: Record<string, number>;
  projects: number;
  trend: number[];
  recent_calls: number;
}

export interface ExtensionRisk {
  level: RiskLevel;
  findings: number;
  verdict: 'approved' | 'review' | 'rejected' | null;
  score: number | null;
  scanned: boolean;
}

export interface PluginContents {
  skills: string[];
  mcp_servers: string[];
  commands: number;
  agents: number;
  hooks: number;
}

export interface ExtensionItem {
  key: string;
  kind: ExtensionKind;
  name: string;
  display_name: string;
  description: string | null;
  version: string | null;
  marketplace: string | null;
  plugin: string | null;
  installed: boolean;
  origin: string | null;
  enabled: boolean | null;
  agents: string[];
  scopes: ExtensionScope[];
  projects: string[];
  transport: string | null;
  contents: PluginContents | null;
  native_usage: { count: number | null; last_used: string | null } | null;
  usage: ExtensionUsage;
  risk: ExtensionRisk;
  /** Used at least once in all history (usage itself may be limited to a window). */
  ever_used?: boolean;
}

export interface ExtensionKindSummary {
  installed: number;
  used: number;
  used_30d: number;
  unused: number;
  project_scoped: number;
  not_installed: number;
  flagged: number;
}

export interface ScanProgress {
  running: boolean;
  done: number;
  total: number;
}

export interface ExtensionsResponse {
  generated_at: string;
  summary: Record<ExtensionKind, ExtensionKindSummary>;
  projects: string[];
  items: ExtensionItem[];
  scan: ScanProgress;
}

export interface ExtensionInstall {
  agent: string;
  scope: ExtensionScope;
  path: string | null;
  project: string | null;
  enabled: boolean | null;
  plugin: string | null;
  config_file: string | null;
}

export interface McpConfigSummary {
  transport: string;
  command?: string | null;
  command_path?: string | null;
  args: string[];
  url_host?: string | null;
  url_scheme?: string | null;
  env_keys: string[];
  header_keys: string[];
  cwd?: string | null;
}

export interface ConfigRisk {
  severity: 'low' | 'medium' | 'high' | 'critical';
  rule: string;
  title: string;
  detail: string;
  agent?: string;
  scope?: string;
  project?: string | null;
}

export interface SecurityFinding {
  perspective: string;
  rule: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  title: string;
  detail: string;
  file: string | null;
  line: number | null;
  excerpt: string | null;
}

export interface SecurityReport {
  score: number;
  grade: string;
  verdict: 'approved' | 'review' | 'rejected';
  perspectives: { id: string; label: string; description: string; status: 'pass' | 'warn' | 'fail' | 'skipped'; score: number | null }[];
  findings: SecurityFinding[];
  digest: string;
  scanned_at: string;
}

export interface ExtensionDetail extends Omit<ExtensionItem, 'usage' | 'transport'> {
  author: string | null;
  license: string | null;
  homepage: string | null;
  repository: string | null;
  category?: string | null;
  keywords?: string[] | null;
  allowed_tools?: string[] | null;
  installed_at?: string | null;
  updated_at?: string | null;
  git_sha?: string | null;
  files?: number;
  size_bytes?: number;
  paths: string[];
  shadows: { agent: string; project: string; overrides: string | null }[] | null;
  installs: ExtensionInstall[];
  mcp?: McpConfigSummary | null;
  risks?: ConfigRisk[];
  usage: ExtensionUsage;
  tools: { tool: string; calls: number; errors: number; p50_ms: number | null }[];
  projects_used: { path: string; sessions: number; installed_here: boolean }[];
  sessions: { id: string; source: string; cwd: string | null; uses: number; last_used: string | null; first_event_id: number }[];
  children: ExtensionItem[];
  security: SecurityReport | null;
  mcp_tools_known: { tool: string; description: string | null }[] | null;
}

export interface SessionExtension {
  key: string;
  kind: ExtensionKind;
  name: string;
  display_name: string;
  installed: boolean;
  scopes: ExtensionScope[];
  plugin: string | null;
  calls: number;
  errors: number;
  tools: string[];
}

/** `days` > 0 limits uses, sessions and failures to that window; last used is always all-time. */
export async function getExtensions(refresh = false, days = 0): Promise<ExtensionsResponse> {
  const params = new URLSearchParams();
  if (refresh) params.set('refresh', 'true');
  if (days) params.set('days', String(days));
  const qs = params.toString();
  return json<ExtensionsResponse>(await fetch(`/v1/extensions${qs ? `?${qs}` : ''}`));
}

export async function getExtensionDetail(key: string): Promise<ExtensionDetail> {
  return json<ExtensionDetail>(await fetch(`/v1/extensions/detail?key=${encodeURIComponent(key)}`));
}

export async function scanExtension(key: string): Promise<SecurityReport> {
  return json<SecurityReport>(await fetch(`/v1/extensions/scan?key=${encodeURIComponent(key)}`, { method: 'POST' }));
}

export async function scanAllExtensions(): Promise<ScanProgress> {
  return json<ScanProgress>(await fetch('/v1/extensions/scan-all', { method: 'POST' }));
}

export async function getSessionExtensions(id: string): Promise<SessionExtension[]> {
  const r = await json<{ extensions: SessionExtension[] }>(await fetch(`/v1/sessions/${encodeURIComponent(id)}/extensions`));
  return r.extensions;
}

// --- user rules (backend/app/user_rules.py) ---------------------------------------

export type RuleFieldKind = 'text' | 'number' | 'enum';
export type RuleType = 'match' | 'threshold';
export type RuleAction = 'finding' | 'ask' | 'deny';

export interface RuleField {
  name: string;
  label: string;
  kind: RuleFieldKind;
  /** `pre`: known before the tool runs (a rule over only these could block). */
  phase: 'pre' | 'post';
  options: string[];
  groupable: boolean;
}

export interface RuleOperator {
  name: string;
  label: string;
  kinds: RuleFieldKind[];
  value: 'none' | 'one' | 'list';
}

export interface RuleSchema {
  version: number;
  types: RuleType[];
  pillars: InsightPillar[];
  severities: InsightSeverity[];
  actions: RuleAction[];
  enforcement_enabled: boolean;
  sources: string[];
  fields: RuleField[];
  operators: RuleOperator[];
  aggregates: ('count' | 'sum' | 'distinct')[];
}

export interface RuleLeaf {
  field: string;
  op: string;
  value?: string | number | string[];
}
export type RuleCondition = RuleLeaf | { all: RuleCondition[] } | { any: RuleCondition[] } | { not: RuleCondition };

export interface RuleThreshold {
  group_by: string[];
  aggregate: 'count' | 'sum' | 'distinct';
  field?: string;
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
  value: number;
}

export interface RuleSpec {
  version?: number;
  name: string;
  description?: string | null;
  pillar: InsightPillar;
  severity: InsightSeverity;
  type: RuleType;
  scope?: { sources: string[]; projects: string[] };
  when: RuleCondition;
  subject?: string;
  threshold?: RuleThreshold;
  recommendation?: string | null;
  action?: RuleAction;
}

export interface UserRule {
  id: string;
  spec: RuleSpec;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  /** False when a stored spec no longer validates (it is skipped, not run). */
  valid: boolean;
  error: string | null;
  /** Decidable before the tool runs, so it could block once enforcement ships. */
  enforceable: boolean;
}

export interface RuleExample {
  label: string;
  count: number;
  session_id: string;
  event_id: number;
}

export interface RulePreview {
  spec: RuleSpec;
  enforceable: boolean;
  /** Most frequent distinct things the rule matched (command, path, URL…). */
  examples: RuleExample[];
  distinct_examples: number;
  window_days: number;
  events_scanned: number;
  events_matched: number;
  sessions_matched: number;
  findings: ActionableInsight[];
}

/** A rule spec the collector rejected; `path` points into the spec (e.g. `when.all[1].value`). */
export class RuleSpecError extends Error {
  constructor(public path: string, message: string) {
    super(message);
  }
}

async function ruleJson<T>(res: Response): Promise<T> {
  if (res.status === 422) {
    const body = await res.json().catch(() => null);
    const d = body?.detail;
    if (d && typeof d === 'object' && 'message' in d) throw new RuleSpecError(String(d.path ?? ''), String(d.message));
  }
  return json<T>(res);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function getRuleSchema(): Promise<RuleSchema> {
  return json<RuleSchema>(await fetch('/v1/rules/schema'));
}

export async function getRules(): Promise<UserRule[]> {
  return (await json<{ rules: UserRule[] }>(await fetch('/v1/rules'))).rules;
}

export async function createRule(spec: RuleSpec, enabled = true): Promise<UserRule> {
  return ruleJson<UserRule>(
    await fetch('/v1/rules', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ spec, enabled }) }),
  );
}

export async function updateRule(id: string, patch: { spec?: RuleSpec; enabled?: boolean }): Promise<UserRule> {
  return ruleJson<UserRule>(
    await fetch(`/v1/rules/${encodeURIComponent(id)}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(patch) }),
  );
}

export async function deleteRule(id: string): Promise<void> {
  await json<{ ok: boolean }>(await fetch(`/v1/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function previewRule(spec: RuleSpec, days = 30, signal?: AbortSignal): Promise<RulePreview> {
  return ruleJson<RulePreview>(
    await fetch('/v1/rules/preview', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ spec, days }), signal }),
  );
}

/** A generalization offered when drafting a rule from one event. */
export interface RuleDraftChoice {
  label: string;
  conditions: RuleLeaf[];
}

export interface RuleEventDraft {
  spec: RuleSpec;
  choices: RuleDraftChoice[];
  picked: number;
  event: { id: number; session_id: string; category: string; tool: string | null; target: string | null; failed: boolean };
}

export async function draftRuleFromEvent(eventId: number): Promise<RuleEventDraft> {
  return json<RuleEventDraft>(await fetch(`/v1/rules/draft/event/${eventId}`));
}

/** Plain English to a rule through the user's AI provider; throws RuleSpecError with a readable message. */
export async function draftRuleFromText(text: string): Promise<RuleSpec> {
  const res = await fetch('/v1/rules/draft/describe', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text }) });
  if (!res.ok && res.status !== 422) {
    const body = await res.json().catch(() => null);
    const msg = typeof body?.detail === 'string' ? body.detail : 'The AI request failed.';
    throw new RuleSpecError('', res.status === 409 ? 'Add an AI key in Settings to describe rules in plain English.' : msg);
  }
  return (await ruleJson<{ spec: RuleSpec }>(res)).spec;
}

// --- Recent edits, outcomes, session shape, recovery ----------------------------

export interface EditedFile {
  project: string | null;
  project_name: string | null;
  path: string;
  relative: string;
  edits: number;
  failed: number;
  added: number;
  removed: number;
  agents: AgentId[];
  sessions: number;
  last: { session_id: string; event_id: number; ts: string; tool: string | null; source: AgentId };
}

export interface EditsFeed {
  days: number;
  totals: { files: number; edits: number; added: number; removed: number; projects: number; truncated: boolean };
  projects: { project: string | null; project_name: string | null; files: number; edits: number; added: number; removed: number; last_ts: string }[];
  items: EditedFile[];
}

export async function getEdits(days: number, f: { project?: string; source?: string } = {}): Promise<EditsFeed> {
  const params = new URLSearchParams({ days: String(days), limit: '400' });
  if (f.project) params.set('project', f.project);
  if (f.source) params.set('source', f.source);
  return json(await fetch(`/v1/edits?${params.toString()}`));
}

export interface OutcomeCounts {
  commits: number;
  pushes: number;
  prs_opened: number;
  prs_merged: number;
  /** From git log, when the collector can read the repository. */
  git_commits: number;
  added: number;
  removed: number;
  files: number;
}

export async function getSessionOutcomes(id: string): Promise<OutcomeCounts> {
  return json(await fetch(`/v1/sessions/${encodeURIComponent(id)}/outcomes`));
}

export type Archetype = 'automation' | 'quick' | 'standard' | 'deep' | 'marathon';

export interface SessionShape {
  days: number;
  sessions: number;
  baseline_sessions: number;
  thresholds: { quick: number; deep: number; marathon: number };
  archetypes: { kind: Archetype; count: number; examples: { session_id: string; active_s: number; prompts: number; source: AgentId }[] }[];
  distributions: Record<'duration' | 'prompts' | 'tools_per_turn', { label: string; count: number }[]>;
  medians: { active_s: number; prompts: number; tools_per_turn: number };
  start_hours: number[];
  concurrency: {
    bucket_s: number;
    peak: number;
    active_hours: number;
    agent_hours: number;
    overlap_share: number;
    buckets: { t: string; peak: number; agent_minutes: number }[];
  };
}

export async function getSessionShape(days: number, tz?: string): Promise<SessionShape> {
  const params = new URLSearchParams({ days: String(days) });
  if (tz) params.set('tz', tz);
  return json(await fetch(`/v1/session-shape?${params.toString()}`));
}

export interface RecoveryRollup {
  failures: number;
  recovered: number;
  /** Only other tools succeeded afterwards: worked around, not fixed. */
  moved_on: number;
  abandoned: number;
  recovery_rate: number | null;
  avg_steps: number | null;
  recovered_by: Partial<Record<'retry' | 'tweak', number>>;
}

export interface RecoveryChain {
  event_id: number;
  ts: string;
  tool: string | null;
  target: string | null;
  category: string | null;
  error: string | null;
  outcome: 'recovered' | 'moved_on' | 'abandoned';
  recovered_by?: 'retry' | 'tweak';
  steps: { event_id: number; tool: string | null; target: string | null; kind: 'retry' | 'tweak' | 'switch'; ok: boolean }[];
}

export async function getSessionRecovery(id: string): Promise<RecoveryRollup & { session_id: string; tool_calls: number; chains: RecoveryChain[] }> {
  return json(await fetch(`/v1/sessions/${encodeURIComponent(id)}/recovery`));
}

export interface SemanticStatus {
  enabled: boolean;
  model?: string;
  dim?: number;
  indexed?: number;
  total?: number;
  running?: boolean;
  error?: string | null;
}

export async function getSemanticStatus(): Promise<SemanticStatus> {
  return json(await fetch('/v1/search/semantic'));
}

export async function getSessionKinds(): Promise<{ counts: Record<Archetype, number> }> {
  return json(await fetch('/v1/sessions/kinds'));
}

export type ShippedKind = 'pr' | 'merge' | 'commit' | 'push';

/** One thing an agent shipped. `url` is the PR, commit or compare page when the
 *  command's output (or the repo's remote) named one; `event_id` is always the
 *  call that did it, so there is somewhere to look either way. */
export interface ShippedItem {
  kind: ShippedKind;
  session_id: string;
  event_id: number | null;
  ts: string;
  project: string | null;
  project_name: string | null;
  title: string | null;
  url: string | null;
  /** command: parsed from what the agent ran; git: found in the repo's history. */
  from: 'command' | 'git';
  number?: number | null;
  sha?: string | null;
  branch?: string | null;
  base?: string | null;
  range?: string | null;
  added?: number;
  removed?: number;
  files?: number;
}

export interface ShippedList {
  days: number;
  counts: Record<ShippedKind, number>;
  items: ShippedItem[];
}

export async function getShipped(days: number, f: { project?: string; sessionId?: string; kind?: ShippedKind } = {}): Promise<ShippedList> {
  const params = new URLSearchParams({ days: String(days) });
  if (f.project) params.set('project', f.project);
  if (f.sessionId) params.set('session_id', f.sessionId);
  if (f.kind) params.set('kind', f.kind);
  return json(await fetch(`/v1/shipped?${params.toString()}`));
}

/** Window totals of what sessions shipped (commits counted from commands and from git). */
export interface OutcomesSummaryLite {
  days: number;
  totals: OutcomeCounts & { sessions_shipped: number };
  projects: (OutcomeCounts & { project: string | null; project_name: string | null; sessions: number })[];
}

export async function getOutcomeTotals(days: number): Promise<OutcomesSummaryLite> {
  return json(await fetch(`/v1/outcomes?days=${days}`));
}

/** Whether `cot mcp` is registered with each agent (backend/app/mcp_install.py). */
export interface McpInstallAgent {
  agent: 'claude' | 'cursor' | 'codex';
  present: boolean;
  config_path: string;
  installed: boolean;
  /** Registered and pointing at this machine's bridge. */
  current: boolean;
}

export interface McpInstallStatus {
  bridge: string;
  bridge_exists: boolean;
  agents: McpInstallAgent[];
}

async function detailOrStatus<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = await res.json();
      if (typeof body.detail === 'string') message = body.detail;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function getMcpInstall(): Promise<McpInstallStatus> {
  return json<McpInstallStatus>(await fetch('/v1/mcp/install'));
}

export async function setMcpInstalled(agent: McpInstallAgent['agent'], on: boolean): Promise<McpInstallAgent> {
  return detailOrStatus<McpInstallAgent>(await fetch(`/v1/mcp/install/${agent}`, { method: on ? 'POST' : 'DELETE' }));
}

/** Something in a session's HTML export that might be a password or token. */
export interface ExportSuggestion {
  id: string;
  kind: string;
  /** The value with its middle elided. */
  preview: string;
  /** Where it appeared, value elided. */
  context: string;
  count: number;
}

export async function scanSessionExport(id: string, opts: { thoughts: boolean; outputs: boolean }): Promise<ExportSuggestion[]> {
  const q = new URLSearchParams({ thoughts: String(opts.thoughts), outputs: String(opts.outputs) });
  return (await json<{ suggestions: ExportSuggestion[] }>(await fetch(`/v1/sessions/${encodeURIComponent(id)}/export/scan?${q}`))).suggestions;
}

export async function exportSessionHtml(
  id: string,
  body: { redact: string[]; terms: string[]; thoughts: boolean; outputs: boolean },
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`/v1/sessions/${encodeURIComponent(id)}/export/html`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `cot-session-${id.slice(0, 8)}.html`;
  return { blob: await res.blob(), filename: name };
}
