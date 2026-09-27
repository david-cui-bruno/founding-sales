import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn/ui's `cn`, copied in as owned code with the rest of `ui/`.
 *
 * `clsx` flattens the conditional argument shapes a component is called with; `twMerge`
 * then resolves conflicts the last-one-wins way a person expects — `cn('px-2', 'px-4')`
 * is `px-4`, not both — so a caller's className always beats the component's default.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
