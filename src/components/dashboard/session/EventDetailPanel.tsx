import type { TimelineItem } from '../../../lib/api';
import { formatDateTime, formatDuration, getCategoryMeta } from '../../../lib/categoryMeta';
import { formatModel } from '../../../lib/modelMeta';
import { conversationMessage, parseDetail, type EditChunk } from '../../../lib/sessionView';
import { useFullEventDetail } from '../../../lib/useFullEventDetail';
import { Icon } from '../../ui/icons';
import { MarkdownContent } from '../../ui/MarkdownContent';
import { AttachmentTags } from './AttachmentTags';

function Pane({ label, children, tone }: { label: string; children: string; tone?: 'add' | 'del' }) {
  const ringCls =
    tone === 'add'
      ? 'ring-1 ring-inset ring-olive/30'
      : tone === 'del'
        ? 'ring-1 ring-inset ring-alert/30'
        : '';
  const labelCls =
    tone === 'add' ? 'text-olive' : tone === 'del' ? 'text-alert' : 'text-fg/60';
  return (
    <div className="min-w-0 flex-1">
      <span className={`font-mono text-label font-semibold uppercase tracking-label ${labelCls}`}>
        {label}
      </span>
      <pre
        className={`scroll-thin mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-small leading-relaxed text-fg/90 ${ringCls}`}>
        {children || '—'}
      </pre>
    </div>
  );
}

function DiffBlock({ edit, index, total }: { edit: EditChunk; index: number; total: number }) {
  return (
    <div className="space-y-2">
      {total > 1 && (
        <span className="font-mono text-label uppercase tracking-label text-fg/40">
          Edit {index + 1} of {total}
        </span>
      )}
      <div className="flex flex-col gap-3 lg:flex-row">
        <Pane label="Before" tone="del">
          {edit.oldText}
        </Pane>
        <Pane label="After" tone="add">
          {edit.newText}
        </Pane>
      </div>
    </div>
  );
}

function QuestionList({ questions }: { questions: NonNullable<TimelineItem['questions']> }) {
  return (
    <div className="space-y-3">
      {questions.map((q, i) => (
        <div key={i} className="rounded-md border border-line/10 bg-panel p-3">
          <div className="flex items-baseline gap-2">
            {q.header && (
              <span className="font-mono text-label font-semibold uppercase tracking-label text-hot">
                {q.header}
              </span>
            )}
            {questions.length > 1 && (
              <span className="font-mono text-label tabular-nums text-fg/40">
                {i + 1}/{questions.length}
              </span>
            )}
          </div>
          <p className="mt-1 font-mono text-small font-semibold text-fg">{q.question}</p>
          {q.options && q.options.length > 0 && (
            <p className="mt-1 font-mono text-data text-fg/40">{q.options.join(' · ')}</p>
          )}
          <div className="mt-2 flex items-start gap-1.5">
            <Icon name="reply" className="mt-0.5 h-3 w-3 shrink-0 text-cobalt" />
            {q.answer ? (
              <span className="font-mono text-code font-semibold text-cobalt">{q.answer}</span>
            ) : q.skipped ? (
              <span className="font-mono text-code font-semibold uppercase tracking-label text-fg/40">
                skipped
              </span>
            ) : (
              <span className="font-mono text-code italic text-fg/40">no recorded answer</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface PlanTodo {
  id?: string;
  content?: string;
  status?: string;
}

function PlanView({ item }: { item: TimelineItem }) {
  let overview = '';
  let plan = '';
  let todos: PlanTodo[] = [];
  try {
    const parsed = JSON.parse(item.detail ?? '{}');
    overview = typeof parsed.overview === 'string' ? parsed.overview : '';
    plan = typeof parsed.plan === 'string' ? parsed.plan : '';
    todos = Array.isArray(parsed.todos) ? parsed.todos : [];
  } catch {
    /* fall back to raw markdown below */
  }

  return (
    <div className="space-y-4">
      {overview && (
        <p className="font-mono text-small leading-relaxed text-fg/80">{overview}</p>
      )}
      {todos.length > 0 && (
        <div>
          <span className="font-mono text-label font-semibold uppercase tracking-label text-olive">
            Todos · {todos.length}
          </span>
          <ul className="mt-2 space-y-1.5">
            {todos.map((t, i) => {
              const done = t.status === 'completed' || t.status === 'done';
              return (
                <li key={t.id ?? i} className="flex items-start gap-2">
                  <Icon
                    name={done ? 'check' : 'square'}
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${done ? 'text-olive' : 'text-fg/40'}`}
                  />
                  <span className={`font-mono text-small ${done ? 'text-fg/60 line-through' : 'text-fg/85'}`}>
                    {t.content ?? t.id}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {plan && (
        <div>
          <span className="font-mono text-label font-semibold uppercase tracking-label text-fg/60">
            Plan
          </span>
          <div className="mt-1.5 rounded-md bg-panel p-3">
            <MarkdownContent content={plan} />
          </div>
        </div>
      )}
    </div>
  );
}

function Body({ item }: { item: TimelineItem }) {
  if (item.category === 'question' && item.questions && item.questions.length > 0) {
    return <QuestionList questions={item.questions} />;
  }

  if (item.category === 'plan') {
    return <PlanView item={item} />;
  }

  const d = parseDetail(item);
  const message = conversationMessage(item, d);

  if (message) {
    return <MarkdownContent content={message} />;
  }

  if (d.edits && d.edits.length) {
    return (
      <div className="space-y-4">
        {d.edits.map((e, i) => (
          <DiffBlock key={i} edit={e} index={i} total={d.edits!.length} />
        ))}
        {d.output != null && d.output !== '' && (
          <Pane label="Result">
            {typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 2)}
          </Pane>
        )}
      </div>
    );
  }

  if (d.content) {
    return <Pane label="Content">{d.content}</Pane>;
  }

  if (d.command != null) {
    return (
      <div className="space-y-3">
        <div>
          <span className="font-mono text-label font-semibold uppercase tracking-label text-fg/60">Command</span>
          <pre className="scroll-thin mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-small text-fg">
            <span className="select-none text-hot">$ </span>
            {d.command}
          </pre>
        </div>
        {(() => {
          if (d.output == null || d.output === '') return null;
          const streams = shellStreams(d.output);
          if (!streams) {
            return <Pane label="Output">{typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 2)}</Pane>;
          }
          return (
            <>
              <Pane label="Output">{streams.out.trimEnd() || '(no output)'}</Pane>
              {streams.err.trim() && <Pane label="Errors">{streams.err.trimEnd()}</Pane>}
            </>
          );
        })()}
      </div>
    );
  }

  const hasIo = d.input != null || d.output != null;
  if (hasIo) {
    return (
      <div className="space-y-3">
        {d.url && (
          <a
            href={d.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-mono text-xs text-cobalt underline-offset-2 hover:underline">
            {d.url}
          </a>
        )}
        <div className="flex flex-col gap-3 lg:flex-row">
          {d.input != null && (
            <Pane label="Input / arguments">
              {typeof d.input === 'string' ? d.input : JSON.stringify(d.input, null, 2)}
            </Pane>
          )}
          {d.output != null && (
            <Pane label="Output / result">
              {typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 2)}
            </Pane>
          )}
        </div>
      </div>
    );
  }

  if (d.text) {
    return <MarkdownContent content={d.text} />;
  }

  return (
    <pre className="scroll-thin max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-small leading-relaxed text-fg/80">
      {d.raw || 'No detail captured.'}
    </pre>
  );
}

interface EventDetailPanelProps {
  item: TimelineItem | null;
  /** Session id, for lazy-loading a truncated event's full detail. */
  sessionId?: string;
  onViewInAll?: () => void;
  /** Jump to another event in the session by id (used for Q&A cross-links). */
  onJump?: (eventId: number) => void;
  /** Inline under a timeline row that already shows kind, time, title and target: drop that header. */
  compact?: boolean;
}

/** Shell results arrive as {stdout, stderr, …}; show the streams as text instead of a JSON dump. */
function shellStreams(output: unknown): { out: string; err: string } | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  if (typeof o.stdout !== 'string' && typeof o.stderr !== 'string') return null;
  return { out: typeof o.stdout === 'string' ? o.stdout : '', err: typeof o.stderr === 'string' ? o.stderr : '' };
}

function QaBanner({ item, onJump }: { item: TimelineItem; onJump?: (id: number) => void }) {
  const link = (id: number, text: string) =>
    onJump ? (
      <button
        type="button"
        onClick={() => onJump(id)}
        className="inline-flex items-center gap-1 font-semibold text-cobalt underline-offset-2 hover:underline">
        {text}
        <Icon name="chevron-right" className="h-3 w-3" />
      </button>
    ) : (
      <span className="font-semibold">{text}</span>
    );

  if (item.is_question) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-cobalt/25 bg-cobalt/[0.06] px-3 py-2 font-mono text-data text-fg/70">
        <Icon name="chat" className="h-3.5 w-3.5 shrink-0 text-cobalt" />
        {item.answered && item.answer_event_id != null ? (
          <span>The agent prompted the user. {link(item.answer_event_id, 'Jump to the answer')}</span>
        ) : item.answered ? (
          <span>The agent prompted the user — answered inline.</span>
        ) : (
          <span>The agent prompted the user — awaiting an answer.</span>
        )}
      </div>
    );
  }

  if (item.answers_event_id != null) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-cobalt/25 bg-cobalt/[0.06] px-3 py-2 font-mono text-data text-fg/70">
        <Icon name="reply" className="h-3.5 w-3.5 shrink-0 text-cobalt" />
        <span>This answered the agent's prompt. {link(item.answers_event_id, 'Jump to the prompt')}</span>
      </div>
    );
  }

  return null;
}

function QaPill({ item }: { item: TimelineItem }) {
  if (item.is_question) {
    return (
      <span
        title="This prompt event contains questions"
        className="rounded border border-line/[0.16] px-1.5 py-0.5 font-mono text-label font-semibold uppercase tracking-label text-fg/60">
        Question
      </span>
    );
  }
  if (item.answers_event_id != null) {
    return (
      <span
        title="This prompt event stores the user answer"
        className="rounded border border-cobalt/40 px-1.5 py-0.5 font-mono text-label font-semibold uppercase tracking-label text-cobalt">
        Answer
      </span>
    );
  }
  return null;
}

export function EventDetailPanel({ item, sessionId, onViewInAll, onJump, compact = false }: EventDetailPanelProps) {
  const { resolved, loading } = useFullEventDetail(item, sessionId);

  if (!item) {
    return (
      <div className="flex h-full min-h-48 items-center justify-center p-8">
        <p className="font-mono text-xs text-fg/40">Select an event to inspect its full detail.</p>
      </div>
    );
  }

  const meta = getCategoryMeta(item.category);
  const isError = item.status === 'error' || item.status === 'blocked';
  const showTarget = item.category !== 'question' && Boolean(item.target);

  if (compact) {
    const chips = isError || item.status === 'interrupted' || item.model;
    return (
      <div className="space-y-3">
        {chips && (
          <div className="flex flex-wrap items-center gap-2">
            {isError && <span className="chip bg-alert/[0.14] text-alert ring-alert/[0.32]">{item.status}</span>}
            {item.status === 'interrupted' && <span className="chip bg-amber/[0.14] text-amber ring-amber/[0.32]">Stopped</span>}
            {item.model && <span className="font-mono text-label uppercase tracking-label text-fg/40">{formatModel(item.model)}</span>}
          </div>
        )}
        <QaBanner item={item} onJump={onJump} />
        {loading && <p className="font-mono text-label uppercase tracking-label text-fg/40">Loading full detail…</p>}
        <Body item={resolved ?? item} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 border-b border-line/10 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
          <span className={`font-mono text-label font-semibold uppercase tracking-label ${meta.color}`}>
            {meta.label}
          </span>
          <QaPill item={item} />
          <span className="font-mono text-label tabular-nums text-fg/60">
            {formatDateTime(item.start_ts || item.ts)}
          </span>
          {item.duration_ms != null && item.duration_ms > 0 && (
            <span className="font-mono text-label tabular-nums text-fg/60">
              · {formatDuration(item.duration_ms)}
            </span>
          )}
          {isError && (
            <span className="chip bg-alert/[0.14] text-alert ring-alert/[0.32]">
              {item.status}
            </span>
          )}
          {item.status === 'interrupted' && (
            <span
              title="The user stopped the agent mid-output — this was cut off"
              className="chip bg-amber/[0.14] text-amber ring-amber/[0.32]">
              <Icon name="stop" className="h-2.5 w-2.5" />
              Stopped
            </span>
          )}
          {item.ongoing && (
            <span className="font-mono text-label uppercase text-cobalt">ongoing</span>
          )}
          {item.model && (
            <span
              title={item.model}
              className="inline-flex items-center gap-1 rounded border border-line/10 px-1.5 py-0.5 font-mono text-label uppercase tracking-label text-fg/60">
              <Icon name="brain" className="h-2.5 w-2.5" />
              {formatModel(item.model)}
            </span>
          )}
          {onViewInAll && (
            <button
              type="button"
              onClick={onViewInAll}
              title="Show this event in the full timeline, with the events before and after it"
              className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 font-mono text-label font-semibold uppercase tracking-label text-fg/60 transition-colors hover:bg-panel hover:text-fg">
              <Icon name="list" className="h-3 w-3" />
              View in all events
            </button>
          )}
        </div>
        <h3 className="font-mono text-base font-semibold text-fg">{item.title}</h3>
        {showTarget && (
          <p className="break-all font-mono text-xs text-fg/60">{item.target}</p>
        )}
        {resolved?.attachments && resolved.attachments.length > 0 && (
          <AttachmentTags attachments={resolved.attachments} />
        )}
      </div>
      <QaBanner item={item} onJump={onJump} />
      {loading && (
        <p className="font-mono text-label uppercase tracking-label text-fg/40">
          Loading full detail…
        </p>
      )}
      <Body item={resolved ?? item} />
    </div>
  );
}
