import type { ComponentProps, JSX } from 'react';
import { cn } from '../lib/utils.ts';

/** The native control, styled. See `ui/README.md` for why it is not the Radix one. */
export function Select({ className, ...props }: ComponentProps<'select'>): JSX.Element {
  return (
    <select
      className={cn(
        'flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-sm',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
