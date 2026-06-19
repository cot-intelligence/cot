import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/** Renders agent/user message text with GFM markdown support. */
export function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  return (
    <div className={`cot-prose scroll-thin max-h-[28rem] overflow-auto ${className}`}>
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
    </div>
  );
}
