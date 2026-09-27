import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, JSX } from 'react';
import { cn } from '../lib/utils.ts';

/**
 * A banner. The three tones the view models already speak — `info`, `warning`,
 * `blocking` — and no colour beyond a left rule, because a banner is a sentence to read
 * rather than a thing to look at.
 */
const alertVariants = cva('rounded-md border-l-2 bg-muted/60 px-3 py-2 text-xs leading-relaxed', {
  variants: {
    tone: {
      info: 'border-l-border text-muted-foreground',
      warning: 'border-l-[var(--status-warn)] text-foreground',
      blocking: 'border-l-destructive text-foreground',
    },
  },
  defaultVariants: { tone: 'info' },
});

export function Alert({
  className,
  tone,
  ...props
}: ComponentProps<'p'> & VariantProps<typeof alertVariants>): JSX.Element {
  return <p role="status" className={cn(alertVariants({ tone }), className)} {...props} />;
}

export { alertVariants };
