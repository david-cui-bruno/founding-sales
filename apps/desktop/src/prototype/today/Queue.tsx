import { AlertCircle, CalendarClock, CheckCircle2, MailOpen, Plus, RotateCw } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { cn } from '../../renderer/lib/utils.ts';
import { Button } from '../../renderer/ui/button.tsx';
import { ineligibility, type Firm } from '../fixtures.ts';
import { dense, EmptyState, Kbd, Skeleton } from '../parts.tsx';
import type { LoadState } from '../state.ts';

/**
 * Today's queue, in the order the plan fixes: scheduled callbacks and time-sensitive
 * replies first, then new prospects, then firms that cannot be called yet with the reason.
 */

const GROUPS: readonly { readonly id: string; readonly label: string; readonly test: (firm: Firm) => boolean }[] = [
  { id: 'callbacks', label: 'Callbacks', test: firm => firm.queue?.reason === 'callback' && ineligibility(firm) === null },
  { id: 'replies', label: 'Replies waiting', test: firm => firm.queue?.reason === 'reply' && ineligibility(firm) === null },
  { id: 'prospects', label: 'New prospects', test: firm => firm.queue?.reason === 'prospect' && ineligibility(firm) === null },
  { id: 'blocked', label: 'Can’t call yet', test: firm => firm.queue !== undefined && ineligibility(firm) !== null },
];

export function orderedQueue(firms: readonly Firm[]): Firm[] {
  return GROUPS.flatMap(group => firms.filter(group.test));
}

function ReasonIcon({ firm }: { readonly firm: Firm }): ReactNode {
  if (ineligibility(firm) !== null) return <AlertCircle className="text-warn-ink" />;
  if (firm.queue?.reason === 'callback') return <CalendarClock className="text-foreground" />;
  if (firm.queue?.reason === 'reply') return <MailOpen className="text-link" />;
  return <span className="mx-[5px] size-1.5 rounded-full bg-strong" />;
}

export function Queue({
  firms,
  selected,
  state,
  done,
  onSelect,
  onRetry,
}: {
  readonly firms: readonly Firm[];
  readonly selected: string;
  readonly state: LoadState;
  readonly done: readonly string[];
  onSelect(id: string): void;
  onRetry(): void;
}): JSX.Element {
  const count = firms.filter(firm => ineligibility(firm) === null).length;
  return (
    <section data-region="queue" aria-label="Today’s queue" className="flex min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="text-sm font-semibold">
          Queue <span className="font-normal text-faint tabular">{state === 'ready' ? count : ''}</span>
        </h2>
        <span className="flex items-center gap-1 text-xs text-faint">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {state === 'loading' ? (
          <div data-testid="queue-loading" className="flex flex-col gap-4 px-2 py-2" aria-label="Loading the queue">
            {[0, 1, 2, 3, 4].map(index => (
              <div key={index} className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2.5 w-1/2" />
              </div>
            ))}
          </div>
        ) : state === 'error' ? (
          <EmptyState
            testId="queue-error"
            icon={<AlertCircle />}
            title="Couldn’t load today’s queue"
            actions={
              <Button variant="outline" className={dense.md} onClick={onRetry}>
                <RotateCw /> Retry
              </Button>
            }
          >
            Callie couldn’t reach the server. Your place, drafts and call notes are kept on this Mac.
          </EmptyState>
        ) : state === 'empty' ? (
          <EmptyState
            testId="queue-empty"
            icon={<CheckCircle2 />}
            title="Nothing to call right now"
            actions={
              <Button variant="outline" className={dense.md}>
                <Plus /> Add a firm
              </Button>
            }
          >
            The next callback is at 2:00 pm. Firms you add appear here as soon as they’re eligible.
          </EmptyState>
        ) : (
          GROUPS.map(group => {
            const rows = firms.filter(group.test);
            if (rows.length === 0) return null;
            return (
              <div key={group.id} className="mb-3">
                <h3 className="flex h-7 items-center justify-between px-2 text-xs font-medium text-muted-foreground">
                  {group.label}
                  <span className="text-faint tabular">{rows.length}</span>
                </h3>
                <ul className="flex flex-col gap-px">
                  {rows.map(firm => {
                    const isSelected = firm.id === selected;
                    const finished = done.includes(firm.id);
                    return (
                      <li key={firm.id}>
                        <button
                          type="button"
                          data-testid={`queue-${firm.id}`}
                          aria-current={isSelected ? 'true' : undefined}
                          onClick={() => onSelect(firm.id)}
                          className={cn(
                            'group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0',
                            isSelected ? 'bg-selected' : 'hover:bg-pressed',
                          )}
                        >
                          <span className="flex h-5 items-center">{finished ? <CheckCircle2 className="text-ok-ink" /> : <ReasonIcon firm={firm} />}</span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span
                              title={firm.name}
                              className={cn('truncate text-sm', isSelected ? 'font-medium text-foreground' : 'text-foreground', finished && 'text-muted-foreground line-through decoration-faint')}
                            >
                              {firm.name}
                            </span>
                            <span className={cn('truncate text-xs', ineligibility(firm) === null ? 'text-muted-foreground' : 'text-warn-ink')}>
                              {firm.queue?.line}
                              {firm.city === null ? '' : ` · ${firm.city}`}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
