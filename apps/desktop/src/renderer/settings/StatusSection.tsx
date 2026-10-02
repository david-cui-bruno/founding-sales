import type { JSX } from 'react';
import type { StatusRow } from '../homeView.ts';
import { cn } from '../lib/utils.ts';
import { Section } from './Group.tsx';

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
  ok: 'bg-ok',
  warn: 'bg-warn',
  stop: 'bg-destructive',
  none: 'bg-strong',
});

/**
 * S4R: v2 restyle only. The rows, their keys, their tones and their words are
 * `buildHomeView`'s and are drawn exactly as before; what changed is the weight (a quiet
 * hairline list under a sentence-case title, in the Settings group style).
 */
export function StatusSection({ rows }: { readonly rows: readonly StatusRow[] }): JSX.Element {
  return (
    <Section data-testid="settings-status" title="Status" className="mt-5 border-t-0 pt-0">
      <ul className="flex flex-col">
        {rows.map(row => (
          <li
            key={row.key}
            data-testid={`status-${row.key}`}
            data-tone={row.tone}
            className="flex min-h-[var(--v2-row)] items-center gap-2.5 border-b border-border py-1 text-sm last:border-b-0"
          >
            <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[row.tone])} />
            <span className="flex-1">{row.text}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
