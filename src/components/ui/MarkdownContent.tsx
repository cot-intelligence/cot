import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

interface MemoryCitation {
  entries: MemoryCitationEntry[];
  rolloutIds: string[];
}

interface MemoryCitationEntry {
  source: string;
  lines: string;
  note: string;
}

type ContentSegment =
  | { type: 'markdown'; content: string }
  | { type: 'memory-citation'; citation: MemoryCitation; raw: string };

const MEMORY_CITATION_RE = /<oai-mem-citation>([\s\S]*?)<\/oai-mem-citation>/g;
const CITATION_ENTRY_RE = /([^\s<|]+):(\d+-\d+)\|note=\[([^\]]*)\]/g;
const ROLLOUT_ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function splitMemoryCitations(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(MEMORY_CITATION_RE)) {
    const index = match.index ?? 0;
    const before = content.slice(lastIndex, index);
    if (before.trim()) {
      segments.push({ type: 'markdown', content: before.trimEnd() });
    }

    const raw = match[0];
    segments.push({
      type: 'memory-citation',
      citation: parseMemoryCitation(match[1] ?? ''),
      raw,
    });
    lastIndex = index + raw.length;
  }

  const after = content.slice(lastIndex);
  if (after.trim() || segments.length === 0) {
    segments.push({ type: 'markdown', content: after.trimEnd() });
  }

  return segments;
}

function parseMemoryCitation(block: string): MemoryCitation {
  const entries: MemoryCitationEntry[] = [];
  for (const match of block.matchAll(CITATION_ENTRY_RE)) {
    entries.push({
      source: match[1],
      lines: match[2],
      note: match[3],
    });
  }

  const rolloutSection = block.match(/<rollout_ids>([\s\S]*?)<\/rollout_ids>/)?.[1] ?? '';
  const rolloutIds = [...rolloutSection.matchAll(ROLLOUT_ID_RE)].map((match) => match[0]);

  return { entries, rolloutIds };
}

function MemoryCitationCard({ citation, raw }: { citation: MemoryCitation; raw: string }) {
  const { entries, rolloutIds } = citation;
  const hasParsedContent = entries.length > 0 || rolloutIds.length > 0;

  if (!hasParsedContent) {
    return (
      <pre className="scroll-thin overflow-auto rounded-md border border-line/15 bg-panel p-3 font-mono text-[0.72rem] leading-relaxed text-fg/70">
        {raw}
      </pre>
    );
  }

  return (
    <aside className="rounded-md border border-cobalt/20 bg-cobalt/[0.04] p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-mono text-[0.58rem] font-bold uppercase tracking-widest text-cobalt">
          Memory citations
        </span>
        <span className="font-mono text-[0.55rem] tabular-nums text-fg/35">
          {entries.length} source{entries.length === 1 ? '' : 's'}
        </span>
      </div>

      {entries.length > 0 && (
        <ul className="space-y-1.5">
          {entries.map((entry, index) => (
            <li key={`${entry.source}-${entry.lines}-${index}`} className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="truncate font-mono text-[0.72rem] font-bold text-fg/80">
                  {entry.source}
                </span>
                <span className="shrink-0 font-mono text-[0.58rem] uppercase tracking-widest text-fg/35">
                  Lines {entry.lines}
                </span>
              </div>
              {entry.note && (
                <p className="mt-0.5 font-mono text-[0.68rem] leading-relaxed text-fg/55">
                  {entry.note}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {rolloutIds.length > 0 && (
        <div className="mt-3 border-t border-cobalt/15 pt-2">
          <span className="font-mono text-[0.55rem] font-bold uppercase tracking-widest text-fg/35">
            Rollouts
          </span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {rolloutIds.map((id) => (
              <span
                key={id}
                title={id}
                className="rounded border border-line/15 bg-bg/50 px-1.5 py-0.5 font-mono text-[0.58rem] text-fg/55">
                {id.slice(0, 8)}
              </span>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function MarkdownSegment({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-cobalt underline-offset-2 hover:underline">
            {children}
          </a>
        ),
        pre: ({ children }) => (
          <pre className="scroll-thin overflow-auto rounded-md bg-panel p-3 font-mono text-[0.8rem] leading-relaxed text-fg/90">
            {children}
          </pre>
        ),
        code: ({ className: codeClass, children, ...props }) => {
          const isBlock = Boolean(codeClass?.includes('language-'));
          if (isBlock) {
            return (
              <code className={`${codeClass ?? ''} text-fg/90`} {...props}>
                {children}
              </code>
            );
          }
          return (
            <code
              className="rounded bg-panel px-1 py-0.5 font-mono text-[0.85em] text-fg/90"
              {...props}>
              {children}
            </code>
          );
        },
        table: ({ children }) => (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full border-collapse font-mono text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-line/15 bg-panel px-2 py-1.5 text-left font-bold text-fg">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-line/15 px-2 py-1.5 text-fg/85">{children}</td>
        ),
      }}>
      {content}
    </ReactMarkdown>
  );
}

/** Renders agent/user message text with GFM markdown support. */
export function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  const segments = splitMemoryCitations(content);

  return (
    <div className={`cot-prose scroll-thin max-h-[28rem] overflow-auto ${className}`}>
      {segments.map((segment, index) => (
        <div key={index} className={index > 0 ? 'mt-3' : undefined}>
          {segment.type === 'markdown' ? (
            <MarkdownSegment content={segment.content} />
          ) : (
            <MemoryCitationCard citation={segment.citation} raw={segment.raw} />
          )}
        </div>
      ))}
    </div>
  );
}
