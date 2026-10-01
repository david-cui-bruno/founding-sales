import { ArrowUpRight, CalendarDays, CircleDot, Search, X } from 'lucide-react';
import type { JSX } from 'react';
import { cn } from '../../renderer/lib/utils.ts';
import { Button } from '../../renderer/ui/button.tsx';
import { Input } from '../../renderer/ui/input.tsx';
import { BOARD_ONLY, FIRMS, STAGES, type Firm, type Stage } from '../fixtures.ts';
import { Chip, dense, Kbd } from '../parts.tsx';
import { FirmContext } from '../firm/FirmContext.tsx';

/**
 * The Pipeline: a Kanban board with the existing stages (Interested → Demo booked →
 * Decision pending → Onboarding → Live) and Lost behind a filter. Opening a card shows the
 * shared firm context in a side panel, so the board keeps its place.
 */

type Card = Pick<Firm, 'id' | 'name' | 'city' | 'stage' | 'pipeline'>;

const CARDS: readonly Card[] = [...FIRMS.filter(firm => firm.pipeline !== undefined), ...BOARD_ONLY];

const money = (monthly: number): string => `$${monthly.toLocaleString('en-US')}/mo`;

function MeetingChip({ card }: { readonly card: Card }): JSX.Element | null {
  const p = card.pipeline;
  if (p === undefined || p.meeting === null) return null;
  const tone = p.meetingState === 'confirmed' ? 'ok' : p.meetingState === 'requested' ? 'warn' : 'neutral';
  const word = p.meetingState === 'confirmed' ? 'Confirmed' : p.meetingState === 'requested' ? 'Not booked yet' : 'Held';
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <CalendarDays className="size-3 shrink-0 text-faint" aria-hidden />
      <span className="min-w-0 truncate text-muted-foreground">{p.meeting}</span>
      <Chip tone={tone} className="ml-auto">
        {word}
      </Chip>
    </div>
  );
}

function BoardCard({ card, selected, onOpen }: { readonly card: Card; readonly selected: boolean; onOpen(): void }): JSX.Element {
  const p = card.pipeline;
  return (
    <li>
      <button
        type="button"
        data-testid={`card-${card.id}`}
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
        className={cn(
          'flex w-full flex-col gap-2 rounded-lg border bg-background p-3 text-left transition-[box-shadow,border-color]',
          selected ? 'border-link/60 shadow-md' : 'border-border hover:border-strong hover:shadow-sm',
        )}
      >
        <span className="flex flex-col">
          <span title={card.name} className="line-clamp-2 text-sm font-medium">
            {card.name}
          </span>
          <span className="text-xs text-faint">{card.city}</span>
        </span>
        {p === undefined ? null : (
          <>
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <CircleDot className="size-3 shrink-0 text-faint" aria-hidden />
              <span className="min-w-0 truncate">{p.next}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">{p.nextDue}</span>
            </span>
            <MeetingChip card={card} />
            <span className="flex items-center justify-between border-t border-border pt-2 text-xs">
              {p.value === null ? (
                <span className="text-faint">No value yet</span>
              ) : (
                <span className="tabular">
                  <span className={cn(p.value.kind === 'agreed' ? 'font-medium text-foreground' : 'text-muted-foreground')}>{money(p.value.monthly)}</span>
                  <span className="text-faint"> · {p.value.kind}</span>
                </span>
              )}
            </span>
          </>
        )}
      </button>
    </li>
  );
}

export function Pipeline({
  showLost,
  panel,
  onToggleLost,
  onOpen,
  onClose,
  onOpenFull,
}: {
  readonly showLost: boolean;
  readonly panel: string | null;
  onToggleLost(): void;
  onOpen(id: string): void;
  onClose(): void;
  onOpenFull(id: string): void;
}): JSX.Element {
  const stages = STAGES.filter(stage => showLost || stage.id !== 'lost');
  const open = panel === null ? undefined : FIRMS.find(firm => firm.id === panel);
  const openCard = panel === null ? undefined : CARDS.find(card => card.id === panel);
  const total = (stage: Stage): string => {
    const values = CARDS.filter(card => card.stage === stage && card.pipeline?.value !== null && card.pipeline?.value !== undefined);
    const sum = values.reduce((acc, card) => acc + (card.pipeline?.value?.monthly ?? 0), 0);
    return sum === 0 ? '' : money(sum);
  };
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-5">
          <div className="relative w-[240px]">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
            <Input aria-label="Filter the board" placeholder="Filter firms" className="h-7 border-border bg-background pl-7 text-sm" />
          </div>
          <Button variant={showLost ? 'secondary' : 'ghost'} className={cn(dense.md, 'text-muted-foreground')} aria-pressed={showLost} onClick={onToggleLost}>
            {showLost ? 'Hide Lost' : 'Show Lost'}
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">
            <span className="tabular">{CARDS.filter(card => card.stage !== 'lost').length}</span> open ·{' '}
            <span className="tabular">{money(CARDS.filter(card => card.stage !== 'lost').reduce((a, c) => a + (c.pipeline?.value?.monthly ?? 0), 0))}</span> estimated + agreed
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex min-h-full gap-3 p-4">
            {stages.map(stage => {
              const cards = CARDS.filter(card => card.stage === stage.id);
              return (
                <section
                  key={stage.id}
                  aria-label={stage.label}
                  data-testid={`column-${stage.id}`}
                  className={cn(
                    'flex w-[248px] shrink-0 flex-col rounded-lg bg-sidebar p-1.5 min-[1920px]:w-auto min-[1920px]:max-w-[360px] min-[1920px]:min-w-[280px] min-[1920px]:flex-1',
                    stage.id === 'lost' && 'opacity-80',
                  )}
                >
                  <header className="flex h-8 items-center justify-between px-1.5">
                    <h2 className="text-sm font-medium">
                      {stage.label} <span className="font-normal text-faint tabular">{cards.length}</span>
                    </h2>
                    <span className="text-xs text-muted-foreground tabular">{total(stage.id)}</span>
                  </header>
                  {cards.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-faint">Nothing here</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {cards.map(card => (
                        <BoardCard key={card.id} card={card} selected={card.id === panel} onOpen={() => onOpen(card.id)} />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>
      {panel === null ? null : (
        <aside
          data-region="panel"
          aria-label="Firm"
          className="flex w-[400px] shrink-0 flex-col border-l border-border bg-background shadow-lg min-[1920px]:w-[480px]"
        >
          <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
            <span className="min-w-0 flex-1 truncate px-1 text-sm font-semibold" title={open?.name ?? openCard?.name}>
              {open?.name ?? openCard?.name}
            </span>
            <Button variant="ghost" className={cn(dense.icon, 'text-muted-foreground')} aria-label="Open firm page" title="Open firm page" onClick={() => onOpenFull(panel)}>
              <ArrowUpRight />
            </Button>
            <Button variant="ghost" className={cn(dense.icon, 'text-muted-foreground')} aria-label="Close panel" title="Close (Esc)" onClick={onClose}>
              <X />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {open === undefined ? (
              <p className="text-sm text-muted-foreground">
                This card has no fixture detail in the prototype. <Kbd>Esc</Kbd> closes the panel.
              </p>
            ) : (
              <FirmContext firm={open} />
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
