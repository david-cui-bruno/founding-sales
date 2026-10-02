import type { ComponentProps, JSX, ReactNode } from 'react';
import { cn } from '../lib/utils.ts';

/**
 * A group on the Settings page: a hairline above it, a small grey sentence-case title, and
 * the group's own rows (S4R). The same props as `ui/layout.tsx`'s `Section`, which the
 * other views still use in the 1.0.x look; Settings takes the v2 one so its groups are
 * divided rather than headed in capitals.
 */
export function Section({
  title,
  count,
  actions,
  children,
  ...props
}: ComponentProps<'section'> & {
  readonly title: string;
  readonly count?: number;
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <section {...props} className={cn('mt-7 border-t border-border pt-4', props.className)}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h2 className="flex items-baseline gap-1.5 text-xs font-medium text-muted-foreground">
          <span>{title}</span>
          {count === undefined ? null : <small className="text-2xs font-normal text-faint tabular">{count}</small>}
        </h2>
        {actions === undefined ? null : <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
