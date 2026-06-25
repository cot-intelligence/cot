import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { getEventDetail, type TimelineItem } from '../../../lib/api';
import { formatClock, formatDateTime, formatDuration, getCategoryMeta } from '../../../lib/categoryMeta';
import {
  conversationMessage,
  eventKey,
  eventSessionId,
  eventsInRun,
  isConversationCategory,
  parseDetail,
  type EditChunk,
  type SubagentRun,
} from '../../../lib/sessionView';
import { MarkdownContent } from '../../ui/MarkdownContent';
import { AttachmentTags } from './AttachmentTags';

export interface ChatTimelineHandle {
  scrollToAndExpand: (key: string) => void;
}

interface ChatTimelineProps {
  items: TimelineItem[];
  runs: SubagentRun[];
  sessionId: string;
  expansionRequest: ExpansionRequest;
  onCardClick?: (key: string) => void;
}

export interface ExpansionRequest {
  open: boolean;
  nonce: number;
}

type Segment =
  | { type: 'event'; item: TimelineItem }
  | { type: 'subagent'; run: SubagentRun; item: TimelineItem; resultItem: TimelineItem; children: TimelineItem[] };

export const ChatTimeline = forwardRef<ChatTimelineHandle, ChatTimelineProps>(
  function ChatTimeline({ items, runs, sessionId, expansionRequest, onCardClick }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

    // Track which cards are force-expanded (via sidebar click)
    const [forceExpanded, setForceExpanded] = useState<Set<string>>(new Set());
    const keyFor = useCallback((item: TimelineItem) => eventKey(item, sessionId), [sessionId]);

    // Build nested segments: group events that fall inside a subagent run
    const segments = useMemo(() => {
      if (!runs.length) return items.map((item): Segment => ({ type: 'event', item }));

      const childIds = new Set<string>();
      const runChildren = new Map<number, TimelineItem[]>();
      const runResultItems = new Map<number, TimelineItem>();
      for (const run of runs) {
        const children = eventsInRun(items, run);
        runChildren.set(run.item.id, children);
        for (const c of children) childIds.add(keyFor(c));

        const resultItem = items.find(
          (it) =>
            it.category === 'subagent' &&
            it.id !== run.item.id &&
            it.target === run.item.target &&
            it.phase === 'end',
        );
        if (resultItem) runResultItems.set(run.item.id, resultItem);
      }

      const result: Segment[] = [];
      const runInserted = new Set<number>();

      for (const item of items) {
        // If this is the subagent span event itself, insert the group
        if (item.category === 'subagent') {
          const run = runs.find((r) => r.item.id === item.id);
          if (run && !runInserted.has(run.item.id)) {
            runInserted.add(run.item.id);
            result.push({
              type: 'subagent',
              run,
              item,
              resultItem: runResultItems.get(run.item.id) ?? item,
              children: runChildren.get(run.item.id) ?? [],
            });
          }
          continue;
        }
        // Skip events claimed by a subagent group
        if (childIds.has(keyFor(item))) continue;
        result.push({ type: 'event', item });
      }
      return result;
    }, [items, runs, keyFor]);

    useImperativeHandle(ref, () => ({
      scrollToAndExpand(key: string) {
        setForceExpanded((prev) => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
        const el = cardRefs.current.get(key);
        if (!el || !containerRef.current) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }), []);

    useEffect(() => {
      if (!expansionRequest.open) setForceExpanded(new Set());
    }, [expansionRequest]);

    const setCardRef = useCallback((key: string, el: HTMLDivElement | null) => {
      if (el) cardRefs.current.set(key, el);
      else cardRefs.current.delete(key);
    }, []);

    const renderEvent = (item: TimelineItem) => {
      const itemKey = keyFor(item);
      const itemSessionId = eventSessionId(item, sessionId);
      const isConvo = isConversationCategory(item.category);
      return isConvo ? (
        <ConversationCard
          key={itemKey}
          item={item}
          sessionId={itemSessionId}
          eventKey={itemKey}
          ref={(el) => setCardRef(itemKey, el)}
        />
      ) : (
        <ActionCard
          key={itemKey}
          item={item}
          sessionId={itemSessionId}
          eventKey={itemKey}
          forceOpen={forceExpanded.has(itemKey)}
          expansionRequest={expansionRequest}
          ref={(el) => setCardRef(itemKey, el)}
        />
      );
    };

    const handleClick = useCallback((e: React.MouseEvent) => {
      if (!onCardClick) return;
      const target = (e.target as HTMLElement).closest('[data-event-key]');
      if (!target) return;
      const key = target.getAttribute('data-event-key');
      if (key) onCardClick(key);
    }, [onCardClick]);

    return (
      <div ref={containerRef} className="scroll-thin h-full overflow-y-auto" onClick={handleClick}>
        <div className="mx-auto max-w-4xl space-y-1 px-4 py-4 pb-48 sm:px-6">
          {segments.map((seg) =>
            seg.type === 'event' ? (
              renderEvent(seg.item)
            ) : (
              <SubagentGroup
                key={seg.run.item.id}
                run={seg.run}
                resultItem={seg.resultItem}
                sessionId={sessionId}
                expansionRequest={expansionRequest}
                forceOpen={
                  forceExpanded.has(keyFor(seg.run.item)) ||
                  forceExpanded.has(keyFor(seg.item)) ||
                  forceExpanded.has(keyFor(seg.resultItem)) ||
                  seg.children.some((child) => forceExpanded.has(keyFor(child)))
                }
                ref={(el) => {
                  setCardRef(keyFor(seg.run.item), el);
                  setCardRef(keyFor(seg.item), el);
                  setCardRef(keyFor(seg.resultItem), el);
                }}
              >
                {seg.children.map(renderEvent)}
              </SubagentGroup>
            ),
          )}
          {!items.length && (
            <p className="py-16 text-center font-mono text-xs text-fg/40">No events.</p>
          )}
        </div>
      </div>
    );
  },
);

/* ------------------------------------------------------------------ */
/* Subagent group — collapsible wrapper for nested subagent events      */
/* ------------------------------------------------------------------ */

const SubagentGroup = forwardRef<HTMLDivElement, {
  run: SubagentRun;
  resultItem: TimelineItem;
  sessionId: string;
  expansionRequest: ExpansionRequest;
  forceOpen?: boolean;
  children: React.ReactNode;
}>(
  function SubagentGroup({ run, resultItem, sessionId, expansionRequest, forceOpen, children }, ref) {
    const [expanded, setExpanded] = useState(false);
    const open = expanded || forceOpen;

    useEffect(() => {
      setExpanded(expansionRequest.open);
    }, [expansionRequest]);

    return (
      <div
        ref={ref}
        data-event-id={run.item.id}
        className="scroll-mt-4"
      >
        {/* Header row — same height as ActionCard rows */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-2 rounded-lg border border-cobalt/20 bg-cobalt/[0.03] px-3.5 py-2 text-left transition-colors hover:bg-cobalt/[0.06]"
        >
          <span className={`shrink-0 text-[0.55rem] text-cobalt/50 transition-transform ${open ? 'rotate-90' : ''}`}>
            ▸
          </span>
          <span className="h-2 w-2 shrink-0 rounded-full bg-cobalt" />
          <span className="font-mono text-[0.58rem] font-bold uppercase tracking-widest text-cobalt">
            Subagent
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[0.7rem] font-bold text-fg">
            {run.label}
          </span>
          {run.durationMs != null && run.durationMs > 0 && (
            <span className="shrink-0 font-mono text-[0.5rem] tabular-nums text-fg/30">
              {formatDuration(run.durationMs)}
            </span>
          )}
          {run.status === 'success' && (
            <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 font-mono text-[0.48rem] font-bold uppercase text-emerald-600">
              OK
            </span>
          )}
          {run.status && run.status !== 'success' && (
            <span className="shrink-0 rounded bg-vermilion/15 px-1 py-0.5 font-mono text-[0.48rem] font-bold uppercase text-vermilion">
              {run.status}
            </span>
          )}
          <span className="shrink-0 font-mono text-[0.5rem] tabular-nums text-fg/25">
            {formatClock(run.start)}
          </span>
        </button>

        {/* Nested children — indented with left accent */}
        {open && (
          <div className="ml-4 border-l-2 border-cobalt/15 pl-3 pt-1">
            <div className="space-y-1.5">
              <SubagentResultCard item={resultItem} sessionId={sessionId} />
              {children}
            </div>
          </div>
        )}
      </div>
    );
  },
);

function SubagentResultCard({ item, sessionId }: { item: TimelineItem; sessionId: string }) {
  const [full, setFull] = useState<{ detail: string | null; attachments: TimelineItem['attachments'] } | null>(null);
  const needsFull = Boolean(item.detail_truncated && full === null);

  useEffect(() => {
    if (!needsFull) return;
    let cancelled = false;
    getEventDetail(sessionId, item.id)
      .then((res) => { if (!cancelled) setFull({ detail: res.detail, attachments: res.attachments }); })
      .catch(() => { if (!cancelled) setFull({ detail: item.detail, attachments: item.attachments }); });
    return () => { cancelled = true; };
  }, [needsFull, sessionId, item.id, item.detail, item.attachments]);

  const resolved = full ? { ...item, detail: full.detail, attachments: full.attachments ?? item.attachments } : item;
  const d = parseDetail(resolved);
  const message = d.agentResponse?.trim();

  if (!message && needsFull) {
    return (
      <p className="rounded-md bg-panel px-3 py-2 font-mono text-[0.62rem] uppercase tracking-widest text-fg/35">
        Loading subagent response...
      </p>
    );
  }
  if (!message) return null;

  return (
    <ConversationCard
      item={{
        ...resolved,
        category: 'response',
        title: 'Agent response',
        detail: message,
        detail_truncated: false,
      }}
      sessionId={sessionId}
      eventKey={eventKey(item, sessionId)}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Conversation cards — always expanded, chat-bubble style             */
/* ------------------------------------------------------------------ */

const ConversationCard = forwardRef<HTMLDivElement, { item: TimelineItem; sessionId: string; eventKey: string }>(
  function ConversationCard({ item, sessionId, eventKey: itemEventKey }, ref) {
    const meta = getCategoryMeta(item.category);
    const isPrompt = item.category === 'prompt' || item.category === 'question';

    return (
      <div
        ref={ref}
        data-event-key={itemEventKey}
        className={`scroll-mt-4 rounded-lg px-4 py-3 ${
          item.inlined_approval_review ? 'border-l-2 border-cobalt/25 ' : ''
        }${item.inlined_reviewed_session ? 'border-l-2 border-fg/15 ' : ''}${
          isPrompt
            ? 'border border-fg/10 bg-surface'
            : 'bg-transparent'
        }`}
      >
        {/* Sender line */}
        <div className="mb-2 flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
          <span className={`font-mono text-[0.58rem] font-bold uppercase tracking-widest ${meta.color}`}>
            {isPrompt ? 'User' : item.category === 'thought' ? 'Thinking' : 'Agent'}
          </span>
          {item.inlined_approval_review && (
            <span className="rounded bg-cobalt/10 px-1 py-0.5 font-mono text-[0.48rem] font-bold uppercase tracking-widest text-cobalt">
              Review
            </span>
          )}
          {item.inlined_reviewed_session && (
            <span className="rounded bg-fg/8 px-1 py-0.5 font-mono text-[0.48rem] font-bold uppercase tracking-widest text-fg/45">
              Reviewed session
            </span>
          )}
          <span
            className="font-mono text-[0.5rem] tabular-nums text-fg/30"
            title={formatDateTime(item.start_ts || item.ts)}
          >
            {formatClock(item.start_ts || item.ts)}
          </span>
          {item.duration_ms != null && item.duration_ms > 0 && (
            <span className="font-mono text-[0.5rem] tabular-nums text-fg/25">
              {formatDuration(item.duration_ms)}
            </span>
          )}
          {item.status === 'interrupted' && (
            <span className="rounded border border-vermilion/50 px-1 py-0.5 font-mono text-[0.5rem] font-bold uppercase text-vermilion">
              Stopped
            </span>
          )}
        </div>

        {/* Attachments */}
        {item.attachments && item.attachments.length > 0 && (
          <div className="mb-2">
            <AttachmentTags attachments={item.attachments} />
          </div>
        )}

        {/* Body — always shown */}
        <div className={item.category === 'thought' ? 'text-fg/60' : ''}>
          <CardBody item={item} sessionId={sessionId} />
        </div>
      </div>
    );
  },
);

/* ------------------------------------------------------------------ */
/* Action cards — collapsed by default, expand on click                */
/* ------------------------------------------------------------------ */

const ActionCard = forwardRef<HTMLDivElement, {
  item: TimelineItem;
  sessionId: string;
  eventKey: string;
  forceOpen?: boolean;
  expansionRequest: ExpansionRequest;
}>(
  function ActionCard({ item, sessionId, eventKey: itemEventKey, forceOpen, expansionRequest }, ref) {
    const [expanded, setExpanded] = useState(false);
    const open = expanded || forceOpen;
    const meta = getCategoryMeta(item.category);
    const isError = item.status === 'error' || item.status === 'blocked';
    const showTarget = item.category !== 'question' && Boolean(item.target);

    useEffect(() => {
      setExpanded(expansionRequest.open);
    }, [expansionRequest]);

    return (
      <div
        ref={ref}
        data-event-key={itemEventKey}
        className={`group scroll-mt-4 rounded-lg border border-line/5 transition-colors hover:border-line/15 ${
          item.inlined_approval_review ? 'border-l-2 border-l-cobalt/25' : ''
        }${item.inlined_reviewed_session ? ' border-l-2 border-l-fg/15' : ''}`}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-2 px-3.5 py-2 text-left"
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
          <span className={`shrink-0 font-mono text-[0.55rem] font-bold uppercase tracking-widest ${meta.color}`}>
            {meta.label}
          </span>
          {item.inlined_approval_review && (
            <span className="shrink-0 rounded bg-cobalt/10 px-1 py-0.5 font-mono text-[0.48rem] font-bold uppercase tracking-widest text-cobalt">
              Review
            </span>
          )}
          {item.inlined_reviewed_session && (
            <span className="shrink-0 rounded bg-fg/8 px-1 py-0.5 font-mono text-[0.48rem] font-bold uppercase tracking-widest text-fg/45">
              Reviewed session
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[0.78rem] font-bold text-fg/80">
            {item.title}
          </span>
          {showTarget && (
            <span className="hidden max-w-48 shrink-0 truncate font-mono text-[0.58rem] text-fg/35 sm:block">
              {item.target}
            </span>
          )}
          {item.duration_ms != null && item.duration_ms > 0 && (
            <span className="shrink-0 font-mono text-[0.52rem] tabular-nums text-fg/30">
              {formatDuration(item.duration_ms)}
            </span>
          )}
          <span
            className="shrink-0 font-mono text-[0.52rem] tabular-nums text-fg/25"
            title={formatDateTime(item.start_ts || item.ts)}
          >
            {formatClock(item.start_ts || item.ts)}
          </span>
          {isError && (
            <span className="shrink-0 rounded bg-vermilion px-1 py-0.5 font-mono text-[0.48rem] font-bold uppercase text-cream">
              {item.status}
            </span>
          )}
          {item.status === 'interrupted' && (
            <span className="shrink-0 rounded border border-vermilion/50 px-1 py-0.5 font-mono text-[0.48rem] font-bold uppercase text-vermilion">
              Stopped
            </span>
          )}
          <span className={`shrink-0 text-[0.55rem] text-fg/25 transition-transform ${open ? 'rotate-90' : ''}`}>
            ▸
          </span>
        </button>

        {open && (
          <div className="border-t border-line/10 px-3.5 py-3">
            {showTarget && (
              <p className="mb-2 break-all font-mono text-xs text-fg/45 sm:hidden">{item.target}</p>
            )}
            {item.attachments && item.attachments.length > 0 && (
              <div className="mb-3">
                <AttachmentTags attachments={item.attachments} />
              </div>
            )}
            <CardBody item={item} sessionId={sessionId} />
          </div>
        )}
      </div>
    );
  },
);

/* ------------------------------------------------------------------ */
/* Card body — renders the event detail                                */
/* ------------------------------------------------------------------ */

function CardBody({ item, sessionId }: { item: TimelineItem; sessionId: string }) {
  const [full, setFull] = useState<{ detail: string | null; attachments: TimelineItem['attachments'] } | null>(null);
  const needsFull = Boolean(item.detail_truncated && full === null);

  useEffect(() => {
    if (!needsFull) return;
    let cancelled = false;
    getEventDetail(sessionId, item.id)
      .then((res) => { if (!cancelled) setFull({ detail: res.detail, attachments: res.attachments }); })
      .catch(() => { if (!cancelled) setFull({ detail: item.detail, attachments: item.attachments }); });
    return () => { cancelled = true; };
  }, [needsFull, sessionId, item.id, item.detail, item.attachments]);

  const resolved = full ? { ...item, detail: full.detail, attachments: full.attachments ?? item.attachments } : item;
  const loading = Boolean(item.detail_truncated && !full);

  if (item.category === 'question' && item.questions && item.questions.length > 0) {
    return <QuestionCards questions={item.questions} />;
  }
  if (item.category === 'plan') {
    return <PlanBody item={resolved} />;
  }

  const d = parseDetail(resolved);
  const message = conversationMessage(resolved, d);
  if (message) return <MarkdownContent content={message} />;

  if (d.edits && d.edits.length) {
    return (
      <div className="space-y-3">
        {d.edits.map((e, i) => <DiffBlock key={i} edit={e} index={i} total={d.edits!.length} />)}
        {d.output != null && d.output !== '' && (
          <CodePane label="Result">{typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 2)}</CodePane>
        )}
      </div>
    );
  }
  if (d.content) return <CodePane label="Content">{d.content}</CodePane>;
  if (d.command != null) {
    return (
      <div className="space-y-2">
        <pre className="scroll-thin max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-[0.8rem] text-fg">
          <span className="select-none text-vermilion">$ </span>{d.command}
        </pre>
        {d.output != null && d.output !== '' && (
          <CodePane label="Output">{typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 2)}</CodePane>
        )}
      </div>
    );
  }
  if (d.input != null || d.output != null) {
    return (
      <div className="flex flex-col gap-2 lg:flex-row">
        {d.input != null && <CodePane label="Input">{typeof d.input === 'string' ? d.input : JSON.stringify(d.input, null, 2)}</CodePane>}
        {d.output != null && <CodePane label="Output">{typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 2)}</CodePane>}
      </div>
    );
  }
  if (d.text) return <MarkdownContent content={d.text} />;
  if (loading) return <p className="font-mono text-[0.62rem] uppercase tracking-widest text-fg/35">Loading…</p>;

  return (
    <pre className="scroll-thin max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-[0.8rem] leading-relaxed text-fg/80">
      {d.raw || 'No detail captured.'}
    </pre>
  );
}

/* ------------------------------------------------------------------ */

function CodePane({ label, children }: { label: string; children: string }) {
  return (
    <div className="min-w-0 flex-1">
      <span className="font-mono text-[0.6rem] font-bold uppercase tracking-widest text-fg/40">{label}</span>
      <pre className="scroll-thin mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-[0.8rem] leading-relaxed text-fg/90">
        {children || '—'}
      </pre>
    </div>
  );
}

function DiffBlock({ edit, index, total }: { edit: EditChunk; index: number; total: number }) {
  return (
    <div className="space-y-1">
      {total > 1 && (
        <span className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/35">Edit {index + 1} of {total}</span>
      )}
      <div className="flex flex-col gap-2 lg:flex-row">
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[0.6rem] font-bold uppercase tracking-widest text-vermilion">Before</span>
          <pre className="scroll-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-[0.8rem] leading-relaxed text-fg/90 ring-1 ring-inset ring-vermilion/30">
            {edit.oldText || '—'}
          </pre>
        </div>
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[0.6rem] font-bold uppercase tracking-widest text-olive">After</span>
          <pre className="scroll-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-[0.8rem] leading-relaxed text-fg/90 ring-1 ring-inset ring-olive/30">
            {edit.newText || '—'}
          </pre>
        </div>
      </div>
    </div>
  );
}

function QuestionCards({ questions }: { questions: NonNullable<TimelineItem['questions']> }) {
  return (
    <div className="space-y-2">
      {questions.map((q, i) => (
        <div key={i} className="rounded-md border border-line/15 bg-panel p-3">
          {q.header && (
            <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-vermilion">{q.header}</span>
          )}
          <p className="mt-1 font-mono text-[0.82rem] font-bold text-fg">{q.question}</p>
          {q.options && q.options.length > 0 && (
            <p className="mt-1 font-mono text-[0.66rem] text-fg/40">{q.options.join(' · ')}</p>
          )}
          <div className="mt-2 flex items-start gap-1.5">
            {q.answer ? (
              <span className="font-mono text-[0.78rem] font-bold text-cobalt">{q.answer}</span>
            ) : q.skipped ? (
              <span className="font-mono text-[0.72rem] font-bold uppercase tracking-widest text-fg/40">skipped</span>
            ) : (
              <span className="font-mono text-[0.72rem] italic text-fg/35">no recorded answer</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function PlanBody({ item }: { item: TimelineItem }) {
  let overview = '';
  let plan = '';
  let todos: { id?: string; content?: string; status?: string }[] = [];
  try {
    const parsed = JSON.parse(item.detail ?? '{}');
    overview = typeof parsed.overview === 'string' ? parsed.overview : '';
    plan = typeof parsed.plan === 'string' ? parsed.plan : '';
    todos = Array.isArray(parsed.todos) ? parsed.todos : [];
  } catch { /* fallback */ }

  return (
    <div className="space-y-3">
      {overview && <p className="font-mono text-[0.82rem] leading-relaxed text-fg/80">{overview}</p>}
      {todos.length > 0 && (
        <ul className="space-y-1">
          {todos.map((t, i) => {
            const done = t.status === 'completed' || t.status === 'done';
            return (
              <li key={t.id ?? i} className="flex items-start gap-2 font-mono text-[0.8rem]">
                <span className={`mt-0.5 ${done ? 'text-olive' : 'text-fg/35'}`}>{done ? '✓' : '○'}</span>
                <span className={done ? 'text-fg/45 line-through' : 'text-fg/85'}>{t.content ?? t.id}</span>
              </li>
            );
          })}
        </ul>
      )}
      {plan && (
        <div className="rounded-md bg-panel p-3">
          <MarkdownContent content={plan} />
        </div>
      )}
    </div>
  );
}
