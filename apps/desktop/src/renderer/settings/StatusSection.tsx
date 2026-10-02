import type { JSX } from 'react';
import type { StatusRow } from '../homeView.ts';
import { cn } from '../lib/utils.ts';
import { Section } from '../ui/layout.tsx';

/**
 * Settings › Status: the routine state of the system, in one place (slice 3a, C0).
 *
 * The mailbox, the calling number, sending, the domain, the version and whether Callie is
 * online were a column of dots in the sidebar on every view. They are routine, so they live
 * here, where somebody looks for them on purpose. What is not routine stays beside the
 * control it affects: a missing calling number is in Needs you, an offline or stale list is
 * a line above Today's queue, and the staged update's Restart stays in the sidebar.
 *
 * It decides nothing: `buildHomeView` says what the rows are.
 */

const TONE_DOT: Readonly<Record<StatusRow['tone'], string>> = Object.freeze({
  ok: 'bg-[var(--status-ok)]',
  warn: 'bg-[var(--status-warn)]',
  stop: 'bg-destructive',
  none: 'bg-border',
});

export function StatusSection({ rows }: { readonly rows: readonly StatusRow[] }): JSX.Element {
  return (
    <Section data-testid="settings-status" title="Status">
      <ul className="flex flex-col border-t border-border">
        {rows.map(row => (
          <li
            key={row.key}
            data-testid={`status-${row.key}`}
            data-tone={row.tone}
            className="flex items-center gap-2.5 border-b border-border py-1.5 text-sm last:border-b-0"
          >
            <span className={cn('size-[7px] shrink-0 rounded-full', TONE_DOT[row.tone])} />
            <span className="flex-1">{row.text}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
