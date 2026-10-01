import { AlertCircle, CalendarClock, CheckCircle2, Clock, MailOpen, StickyNote } from 'lucide-react';
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { useDrafts } from '../app/drafts.tsx';
import { cn } from '../lib/utils.ts';
import type { TodayCard } from '../todayContract.ts';
import { EmptyState, Kbd } from '../v2/parts.tsx';
import { groupOf, queueGroups, queueLine, type QueueGroupId } from './queueView.ts';

/**
 * Today's queue, the left region (slice S2): callbacks, replies waiting, what is due, new
 * prospects, then the firms that cannot be called yet with the reason, each group in the
 * server's own order (`queueView.ts`).
 *
 * The scroll position lives with the caller (`scrollTop`, `onScroll`), so it survives a
 * firm being chosen, a call ending and the view being left and come back to. A firm with a
 * note typed and not yet recorded carries a small "note" mark, so nothing typed is lost
 * sight of on the way to the next call.
 */

function ReasonIcon({ group }: { readonly group: QueueGroupId }): ReactNode {
  if (group === 'blocked') return <AlertCircle className="text-warn-ink" />;
  if (group === 'callbacks') return <CalendarClock className="text-foreground" />;
  if (group === 'replies') return <MailOpen className="text-link" />;
  if (group === 'due') return <Clock className="text-muted-foreground" />;
  return <span className="mx-[5px] size-1.5 rounded-full bg-strong" />;
}

export function QueuePanel({
  cards,
  selected,
  done,
  locked,
  scrollTop,
  onScroll,
  onSelect,
  footer,
}: {
  readonly cards: readonly TodayCard[];
  readonly selected: string | null;
  /** Firms called in this sitting: ticked, and skipped by Next firm. */
  readonly done: ReadonlySet<string>;
  /** A call is live: the queue cannot move the selection away from it. */
  readonly locked: boolean;
  readonly scrollTop: number;
  onScroll(top: number): void;
  onSelect(firmId: string): void;
  /** Below the list: what needs the person, and the numbers. */
  readonly footer?: ReactNode;
}): JSX.Element {
  const groups = queueGroups(cards);
  const callable = cards.filter(card => groupOf(card) !== 'blocked').length;
  const list = useRef<HTMLDivElement>(null);
  const drafts = useDrafts();
  useEffect(() => {
    if (list.current !== null) list.current.scrollTop = scrollTop;
    // Restored once, when the queue is drawn; afterwards the scroll is the person's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section data-region="queue" aria-label="Today’s queue" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="text-sm font-semibold">
          Queue <span data-testid="queue-count" className="font-normal text-faint tabular">{callable}</span>
        </h2>
        <span className="flex items-center gap-1 text-xs text-faint" aria-hidden>
          <Kbd>J</Kbd>
          <Kbd>K</Kbd>
        </span>
      </header>
      <div
        ref={list}
        data-testid="queue-list"
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
        onScroll={event => onScroll(event.currentTarget.scrollTop)}
      >
        {groups.length === 0 ? (
          <EmptyState testId="queue-empty" icon={<CheckCircle2 />} title="Nothing to call right now">
            Firms you add appear here as soon as they are added; callbacks on the day they are due.
          </EmptyState>
        ) : (
          groups.map(group => (
            <div key={group.id} data-testid="queue-group" data-group={group.id} className="mb-3">
              <h3 className="flex h-7 items-center justify-between px-2 text-xs font-medium text-muted-foreground">
                <span data-testid="queue-group-label">{group.label}</span>
                <span data-testid="queue-group-count" className="text-faint tabular">
                  {group.cards.length}
                </span>
              </h3>
              <ul className="flex flex-col gap-px">
                {group.cards.map(card => {
                  const isSelected = card.firmId === selected;
                  const finished = done.has(card.firmId);
                  const note = (drafts.values[`today:outcome:${card.firmId}:note`] ?? '').trim() !== '';
                  return (
                    <li key={card.firmId}>
                      <button
                        type="button"
                        data-testid="queue-row"
                        data-firm={card.firmId}
                        aria-current={isSelected ? 'true' : undefined}
                        disabled={locked && !isSelected}
                        title={locked && !isSelected ? 'On a call: hang up first' : card.firmName}
                        onClick={() => onSelect(card.firmId)}
                        className={cn(
                          'group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0',
                          isSelected ? 'bg-selected' : 'hover:bg-pressed',
                        )}
                      >
                        <span className="flex h-5 items-center">
                          {finished ? <CheckCircle2 className="text-ok-ink" aria-label="Called" /> : <ReasonIcon group={group.id} />}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span
                            data-testid="queue-firm"
                            className={cn(
                              'truncate text-sm text-foreground',
                              isSelected && 'font-medium',
                              finished && 'text-muted-foreground line-through decoration-faint',
                            )}
                          >
                            {card.firmName}
                          </span>
                          <span
                            data-testid="queue-line"
                            className={cn('truncate text-xs', group.id === 'blocked' ? 'text-warn-ink' : 'text-muted-foreground')}
                          >
                            {queueLine(card)}
                          </span>
                        </span>
                        {note ? (
                          <span data-testid="queue-note" title="A note is typed and not yet saved" className="flex h-5 items-center text-faint">
                            <StickyNote />
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
        {footer}
      </div>
    </section>
  );
}
