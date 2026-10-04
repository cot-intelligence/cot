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
    <header className="space-y-3">
      {above}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 space-y-2">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="text-[1.75rem] font-semibold leading-[1.1] tracking-display text-fg sm:text-[2rem]">
            {title}
          </h1>
          {description && <p className="max-w-[68ch] text-body text-fg/60">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
      </div>
    </header>
  );
}
