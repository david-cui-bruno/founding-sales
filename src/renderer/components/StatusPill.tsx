import type { ReactNode } from 'react';

/**
 * Neutral by default. `urgent` is reserved for P0 and equivalent meaningful
 * states; `positive` for confirmed good outcomes; `danger` for failures.
 */
export type StatusPillTone = 'neutral' | 'urgent' | 'positive' | 'danger';

export type StatusPillProps = {
  tone?: StatusPillTone;
  children: ReactNode;
};

export function StatusPill({ tone = 'neutral', children }: StatusPillProps) {
  return (
    <span className={`status-pill status-pill--${tone}`}>{children}</span>
  );
}
