import type { ReactNode } from 'react';

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  /** Right-aligned controls (filters, buttons) that belong to the whole page. */
  actions?: ReactNode;
  /** Extra line above the eyebrow, e.g. a back link. */
  above?: ReactNode;
}

/** Top-of-page title block shared by every dashboard view. */
export function PageHeader({ eyebrow, title, description, actions, above }: PageHeaderProps) {
  return (
    <header className="space-y-3 border-b border-line/10 pb-6">
      {above}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 space-y-2">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="font-serif text-[2rem] font-normal leading-[1.05] tracking-[-0.03em] text-fg sm:text-[2.5rem]">
            {title}
          </h1>
          {description && <p className="max-w-2xl text-sm leading-relaxed text-fg/55">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
      </div>
    </header>
  );
}
