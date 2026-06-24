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
  | 'other';

export interface SessionSummary {
  id: string;
  source: AgentId;
  status: string;
  cwd: string | null;
  models: string[];
  archived: boolean;
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
}

export interface TimelineItem {
  id: number;
  hook: string;
  tool: string | null;
  phase: string;
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
  ongoing?: boolean;
  payload?: string | null;
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
}

export interface QuestionPart {
  header?: string | null;
  question: string;
  options?: string[];
  answer?: string | null;
  skipped?: boolean;
}

export interface Clarification {
  question_event_id: number;
  question_ts: string;
  question_excerpt: string;
  answer_event_id: number | null;
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

export interface SessionDetail {
  summary: SessionSummary;
  components: Components;
  events: TimelineItem[];
  timeline: TimelineItem[];
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
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url} -> ${res.status}`);
  return (await res.json()) as T;
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

export interface Settings {
  telemetry_enabled: boolean;
  /** Hard-disabled for this deployment via COT_DISABLE_TELEMETRY. */
  telemetry_env_disabled: boolean;
  telemetry_endpoint: string;
}

export async function getSettings(): Promise<Settings> {
  return json<Settings>(await fetch('/v1/settings'));
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
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
}

export interface RetentionCleanupResult {
  dry_run: boolean;
  policy: RetentionPolicy;
  cutoff: string;
  eligible_sessions: number;
  eligible_events: number;
  deleted_sessions: number;
  deleted_events: number;
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

export async function getMetrics(): Promise<Metrics> {
  return json<Metrics>(await fetch('/v1/metrics'));
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
  hooks: string[];
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
  const qs = params.toString();
  const data = await json<{ sessions: SessionSummary[] }>(
    await fetch(`/v1/sessions${qs ? `?${qs}` : ''}`),
  );
  return data.sessions;
}

export async function getSessionDetail(id: string): Promise<SessionDetail> {
  return json<SessionDetail>(await fetch(`/v1/sessions/${id}`));
}

export async function setSessionArchived(id: string, archived: boolean): Promise<void> {
  const action = archived ? 'archive' : 'unarchive';
  await json(await fetch(`/v1/sessions/${id}/${action}`, { method: 'POST' }));
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

export async function search(q: string, limit = 40): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  const data = await json<{ results: SearchResult[] }>(
    await fetch(`/v1/search?${params.toString()}`),
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
  const sid = `sess_${Math.random().toString(16).slice(2, 9)}`;
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
