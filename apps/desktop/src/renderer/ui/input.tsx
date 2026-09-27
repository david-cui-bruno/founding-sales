import type { ComponentProps, JSX } from 'react';
import { cn } from '../lib/utils.ts';

export function Input({ className, type, ...props }: ComponentProps<'input'>): JSX.Element {
  return (
    <input
      type={type}
      className={cn(
        'flex h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1 text-sm transition-colors',
        'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
