import { ChevronRight } from 'lucide-react';
import type { JSX } from 'react';
import { figureText, type FigureCell, type HomeView } from '../homeView.ts';
import { cn } from '../lib/utils.ts';
import { navigate } from '../routes.ts';

/**
 * Today › Overview: the numbers (slice 3a, C0; David's feedback after 1.0.26).
 *
 * They were a block under the queue, where a glance at the next firm met a table of
 * totals. They have their own subtab now, and each says what it counts:
 *
 *   * every number names its period — "today", "since 24 Sep", or "now" for what is open at
 *     this moment;
 *   * a count that is not confirmed is drawn beside the confirmed one, "3 (+1 unconfirmed)",
 *     never added into it;
 *   * a count somebody can act on is a link to its queue or filter.
 *
 * It decides nothing: `figuresView` in `homeView.ts` says what each cell is.
 */

function Value({ cell }: { readonly cell: FigureCell }): JSX.Element {
  return (
    <span className="flex items-baseline gap-1.5">
      <span data-testid="figure-value" className="text-xl tabular-nums">
        {cell.value}
      </span>
      {cell.unconfirmed === null ? null : (
        <span data-testid="figure-unconfirmed" className="text-xs text-muted-foreground tabular-nums">
          (+{cell.unconfirmed} unconfirmed)
        </span>
      )}
      {cell.note === null ? null : (
        <small data-testid="figure-note" className="text-xs text-muted-foreground">
          {cell.note}
        </small>
      )}
    </span>
  );
}

export function Figures({ home, compact = false }: { readonly home: HomeView; readonly compact?: boolean }): JSX.Element {
  return (
    <section data-testid="figures">
      <h2 data-testid="figures-label" className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {home.figures.label}
      </h2>
      <ul className="flex flex-col border-t border-border">
        {home.figures.cells.map(cell => {
          const link = cell.link;
          const body = (
            <>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span data-testid="figure-label" className="text-sm">
                  {cell.label}
                </span>
                <span data-testid="figure-period" className="text-xs text-muted-foreground">
                  {cell.period}
                </span>
              </span>
              <Value cell={cell} />
              {link === null ? null : <ChevronRight aria-hidden className="size-3.5 shrink-0 text-faint" />}
            </>
          );
          return (
            <li key={cell.key} data-testid={`figure-${cell.key}`} aria-label={`${cell.label}, ${cell.period}: ${figureText(cell)}`} className="border-b border-border last:border-b-0">
              {link === null ? (
                <div className={cn('flex items-center gap-3 px-1', compact ? 'py-1.5' : 'py-2.5')}>{body}</div>
              ) : (
                <button
                  type="button"
                  data-testid="figure-link"
                  onClick={() => {
                    navigate(link);
                  }}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-1 text-left transition-colors hover:bg-muted',
                    compact ? 'py-1.5' : 'py-2.5',
                  )}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {home.figures.line === null ? null : (
        <p data-testid="figures-line" className="mt-2 text-xs text-muted-foreground">
          {home.figures.line}
        </p>
      )}
    </section>
  );
}

/** The Overview subtab's body. */
export function Overview({ home, extras }: { readonly home: HomeView; readonly extras?: JSX.Element | null }): JSX.Element {
  return (
    <div data-testid="today-overview" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[640px] flex-col px-8 pt-8 pb-16">
        <Figures home={home} />
        {extras == null ? null : <div className="mt-9">{extras}</div>}
      </div>
    </div>
  );
}
