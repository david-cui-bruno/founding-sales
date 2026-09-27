import type { ComponentProps, JSX } from 'react';
import { cn } from '../lib/utils.ts';

export function Card({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div className={cn('rounded-lg border border-border bg-card text-card-foreground', className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div className={cn('flex flex-col gap-1 px-4 pt-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>): JSX.Element {
  return <h3 className={cn('text-sm font-medium', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>): JSX.Element {
  return <p className={cn('text-xs text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div className={cn('px-4 py-3', className)} {...props} />;
}
