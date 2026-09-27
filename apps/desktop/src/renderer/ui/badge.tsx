import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, JSX } from 'react';
import { cn } from '../lib/utils.ts';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-border bg-muted text-muted-foreground',
        ok: 'border-transparent bg-[color-mix(in_oklch,var(--status-ok)_14%,white)] text-[color-mix(in_oklch,var(--status-ok)_70%,black)]',
        warn: 'border-transparent bg-[color-mix(in_oklch,var(--status-warn)_16%,white)] text-[color-mix(in_oklch,var(--status-warn)_70%,black)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
