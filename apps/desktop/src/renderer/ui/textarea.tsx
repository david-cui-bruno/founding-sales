import type { ComponentProps, JSX } from 'react';
import { cn } from '../lib/utils.ts';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>): JSX.Element {
  return (
    <textarea
      className={cn(
        'flex min-h-16 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm',
        'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
