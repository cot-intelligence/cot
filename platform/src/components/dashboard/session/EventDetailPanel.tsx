import type { TimelineItem } from '../../../lib/api';
import { formatDuration, formatTime, getCategoryMeta } from '../../../lib/categoryMeta';
import { formatModel } from '../../../lib/modelMeta';
import { conversationMessage, parseDetail, type EditChunk } from '../../../lib/sessionView';
import { Icon } from '../../ui/icons';
import { MarkdownContent } from '../../ui/MarkdownContent';
import { AttachmentTags } from './AttachmentTags';

function Pane({ label, children, tone }: { label: string; children: string; tone?: 'add' | 'del' }) {
  const ringCls =
    tone === 'add'
      ? 'ring-1 ring-inset ring-olive/30'
      : tone === 'del'
        ? 'ring-1 ring-inset ring-vermilion/30'
        : '';
  const labelCls =
    tone === 'add' ? 'text-olive' : tone === 'del' ? 'text-vermilion' : 'text-fg/45';
  return (
    <div className="min-w-0 flex-1">
      <span className={`font-mono text-[0.62rem] font-bold uppercase tracking-widest ${labelCls}`}>
        {label}
      </span>
      <pre
        className={`scroll-thin mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-[0.8rem] leading-relaxed text-fg/90 ${ringCls}`}>
        {children || '—'}
      </pre>
    </div>
  );
}

function DiffBlock({ edit, index, total }: { edit: EditChunk; index: number; total: number }) {
  return (
    <div className="space-y-2">
      {total > 1 && (
        <span className="font-mono text-[0.55rem] uppercase tracking-widest text-fg/35">
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
        <div key={i} className="rounded-md border border-line/15 bg-panel p-3">
          <div className="flex items-baseline gap-2">
            {q.header && (
              <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-vermilion">
                {q.header}
              </span>
            )}
            {questions.length > 1 && (
              <span className="font-mono text-[0.55rem] tabular-nums text-fg/35">
                {i + 1}/{questions.length}
              </span>
            )}
          </div>
          <p className="mt-1 font-mono text-[0.82rem] font-bold text-fg">{q.question}</p>
          {q.options && q.options.length > 0 && (
            <p className="mt-1 font-mono text-[0.66rem] text-fg/40">{q.options.join(' · ')}</p>
          )}
          <div className="mt-2 flex items-start gap-1.5">
            <Icon name="reply" className="mt-0.5 h-3 w-3 shrink-0 text-cobalt" />
            {q.answer ? (
              <span className="font-mono text-[0.78rem] font-bold text-cobalt">{q.answer}</span>
            ) : (
              <span className="font-mono text-[0.72rem] italic text-fg/35">no recorded answer</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Body({ item }: { item: TimelineItem }) {
  if (item.category === 'question' && item.questions && item.questions.length > 0) {
    return <QuestionList questions={item.questions} />;
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
          <span className="font-mono text-[0.62rem] font-bold uppercase tracking-widest text-fg/45">Command</span>
          <pre className="scroll-thin mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-[0.8rem] text-fg">
            <span className="select-none text-vermilion">$ </span>
            {d.command}
          </pre>
        </div>
        {d.output != null && d.output !== '' && (
          <Pane label="Output">
            {typeof d.output === 'string' ? d.output : JSON.stringify(d.output, null, 2)}
          </Pane>
        )}
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
    <pre className="scroll-thin max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 font-mono text-[0.8rem] leading-relaxed text-fg/80">
      {d.raw || 'No detail captured.'}
    </pre>
  );
}

interface EventDetailPanelProps {
  item: TimelineItem | null;
  onViewInAll?: () => void;
  /** Jump to another event in the session by id (used for Q&A cross-links). */
  onJump?: (eventId: number) => void;
}

function QaBanner({ item, onJump }: { item: TimelineItem; onJump?: (id: number) => void }) {
  const link = (id: number, text: string) =>
    onJump ? (
      <button
        type="button"
        onClick={() => onJump(id)}
        className="inline-flex items-center gap-1 font-bold text-cobalt underline-offset-2 hover:underline">
        {text}
        <Icon name="chevron-right" className="h-3 w-3" />
      </button>
    ) : (
      <span className="font-bold">{text}</span>
    );

  if (item.is_question) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-cobalt/25 bg-cobalt/[0.06] px-3 py-2 font-mono text-[0.68rem] text-fg/70">
        <Icon name="chat" className="h-3.5 w-3.5 shrink-0 text-cobalt" />
        {item.answered && item.answer_event_id != null ? (
          <span>The agent asked the user a question. {link(item.answer_event_id, 'Jump to the answer')}</span>
        ) : item.answered ? (
          <span>The agent asked the user a question — answered inline.</span>
        ) : (
          <span>The agent asked the user a question — awaiting an answer.</span>
        )}
      </div>
    );
  }

  if (item.answers_event_id != null) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-cobalt/25 bg-cobalt/[0.06] px-3 py-2 font-mono text-[0.68rem] text-fg/70">
        <Icon name="reply" className="h-3.5 w-3.5 shrink-0 text-cobalt" />
        <span>This prompt answered the agent's question. {link(item.answers_event_id, 'Jump to the question')}</span>
      </div>
    );
  }

  return null;
}

export function EventDetailPanel({ item, onViewInAll, onJump }: EventDetailPanelProps) {
  if (!item) {
    return (
      <div className="flex h-full min-h-48 items-center justify-center p-8">
        <p className="font-mono text-xs text-fg/40">Select an event to inspect its full detail.</p>
      </div>
    );
  }

  const meta = getCategoryMeta(item.category);
  const isError = item.status === 'error' || item.status === 'blocked';

  return (
    <div className="space-y-4">
      <div className="space-y-2 border-b border-line/10 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
          <span className={`font-mono text-[0.62rem] font-bold uppercase tracking-widest ${meta.color}`}>
            {meta.label}
          </span>
          <span className="font-mono text-[0.62rem] tabular-nums text-fg/45">
            {formatTime(item.start_ts || item.ts)}
          </span>
          {item.duration_ms != null && item.duration_ms > 0 && (
            <span className="font-mono text-[0.62rem] tabular-nums text-fg/45">
              · {formatDuration(item.duration_ms)}
            </span>
          )}
          {isError && (
            <span className="rounded-md bg-vermilion px-1.5 py-0.5 font-mono text-[0.55rem] font-bold uppercase tracking-widest text-cream">
              {item.status}
            </span>
          )}
          {item.status === 'interrupted' && (
            <span
              title="The user stopped the agent mid-output — this was cut off"
              className="inline-flex items-center gap-1 rounded-md border border-vermilion/50 px-1.5 py-0.5 font-mono text-[0.55rem] font-bold uppercase tracking-widest text-vermilion">
              <Icon name="stop" className="h-2.5 w-2.5" />
              Stopped
            </span>
          )}
          {item.ongoing && (
            <span className="font-mono text-[0.62rem] uppercase text-cobalt">ongoing</span>
          )}
          {item.model && (
            <span
              title={item.model}
              className="inline-flex items-center gap-1 rounded border border-fg/15 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-widest text-fg/55">
              <Icon name="brain" className="h-2.5 w-2.5" />
              {formatModel(item.model)}
            </span>
          )}
          {onViewInAll && (
            <button
              type="button"
              onClick={onViewInAll}
              title="Show this event in the full timeline, with the events before and after it"
              className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[0.6rem] font-bold uppercase tracking-widest text-fg/50 transition-colors hover:bg-panel hover:text-fg">
              <Icon name="list" className="h-3 w-3" />
              View in all events
            </button>
          )}
        </div>
        <h3 className="font-mono text-base font-bold text-fg">{item.title}</h3>
        {item.target && (
          <p className="break-all font-mono text-xs text-fg/60">{item.target}</p>
        )}
        {item.attachments && item.attachments.length > 0 && (
          <AttachmentTags attachments={item.attachments} />
        )}
      </div>
      <QaBanner item={item} onJump={onJump} />
      <Body item={item} />
    </div>
  );
}
