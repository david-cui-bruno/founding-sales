import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps, JSX } from 'react';
import { cn } from '../lib/utils.ts';

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>): JSX.Element {
  return (
    <LabelPrimitive.Root
      className={cn('flex items-center gap-1.5 text-xs font-medium text-muted-foreground select-none', className)}
      {...props}
    />
  );
}
