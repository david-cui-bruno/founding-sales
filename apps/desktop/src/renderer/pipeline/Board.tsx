import { Search } from 'lucide-react';
import { useLayoutEffect, useRef, type JSX, type MutableRefObject } from 'react';
import { emptyBoardMemory, type BoardMemory, type CardEditor, type CardFeedback } from '../firms/crmMemory.ts';
import type { PipelineView, StageChange, ValueChange } from '../firmWorkspaceContract.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Chip, EmptyState } from '../v2/parts.tsx';
import { useShortcuts } from '../v2/shortcuts.ts';
import { BoardCard } from './BoardCard.tsx';
import { openTotals, totalsOf, valueSummary } from './boardMetrics.ts';

/**
 * The Kanban (slice K, re-skinned for S4): one column per board stage, in the board's order,
 * each scrolling on its own, the whole board scrolling sideways. The columns are the API's,
 * not a hard-coded five: a renamed stage is renamed here, a retired and empty one is hidden,
 * and Lost is there only while the "Show lost" filter asked for it.
 *
 * **The board keeps its place.** Opening a firm shows it in a side panel beside the board,
 * so the board does not move; the full firm page replaces the view and closing it draws the
 * board again from a fresh read. The search text and the scroll offsets live with the caller
 * (`BoardMemory`, in the shell-level memory), which outlives both, and are put back before
 * the first paint.
 */

export { emptyBoardMemory, type BoardMemory };

export function Board({
  pipeline,
  actionsEnabled,
  stageBusy,
  valueBusy,
  search,
  memory,
  onSearch,
  onShowLost,
  onChangeStage,
  onSetValue,
  onOpenFirm,
  selectedFirmId = null,
  selectedOpportunityId = null,
  cardEditors = {},
  onCardEditor,
  feedback = {},
  onlyWithoutValue = false,
  onOnlyWithoutValue,
}: {
  readonly pipeline: PipelineView;
  readonly actionsEnabled: boolean;
  stageBusy(opportunityId: string): boolean;
  valueBusy(opportunityId: string): boolean;
  readonly search: string;
  readonly memory: MutableRefObject<BoardMemory>;
  onSearch(text: string): void;
  onShowLost(show: boolean): void;
  onChangeStage(change: StageChange): void;
  onSetValue(change: ValueChange): void;
  onOpenFirm(firmId: string, opportunityId?: string): void;
  /** The firm open in the side panel. */
  readonly selectedFirmId?: string | null;
  readonly selectedOpportunityId?: string | null;
  /** Which editor is open on each card, by opportunity, and the answer to its last command. */
  readonly cardEditors?: Readonly<Record<string, CardEditor | undefined>>;
  onCardEditor?(opportunityId: string, editor: CardEditor | null): void;
  readonly feedback?: Readonly<Record<string, CardFeedback | undefined>>;
  /** The "no value yet" filter: a count on the toolbar that opens exactly the list it counts. */
  readonly onlyWithoutValue?: boolean;
  onOnlyWithoutValue?(on: boolean): void;
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null);
  const columnNodes = useRef(new Map<string, HTMLElement>());
  const searchBox = useRef<HTMLInputElement | null>(null);
  const needle = search.trim().toLowerCase();
  const columns = pipeline.columns
    // A retired stage with nothing in it is history nobody needs on screen.
    .filter((column) => !(column.stage.retired && column.firms.length === 0));
  const includeLost = pipeline.includeLost === true;

  const visible = (column: PipelineView['columns'][number]) =>
    column.firms.filter(
      (firm) =>
        (needle === '' || firm.name.toLowerCase().includes(needle)) &&
        (!onlyWithoutValue || (pipeline.cards?.[firm.id]?.value ?? null) === null),
    );

  // The open work, as of today: agreed and estimated money apart, no-value firms apart.
  const open = openTotals(pipeline);
  const summary = valueSummary(open);
  const everyFirm = columns.reduce((count, column) => count + column.firms.length, 0);

  // J / K walk the cards in the order they are drawn; / goes to the search box.
  const walk = (delta: 1 | -1): void => {
    // Navigation never leaves focus on a command: a button that had focus (Move, Save) would
    // otherwise run on the Enter that follows J or K (rule K4).
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement) focused.blur();
    if (pipeline.plural !== undefined) {
      const board = pipeline.plural;
      const ids = board.columns
        .flatMap((column) => column.opportunityIds)
        .filter((id) => {
          const card = board.cards[id];
          return (
            card !== undefined &&
            (needle === '' || `${card.firm.name} ${card.displayName ?? ''}`.toLowerCase().includes(needle)) &&
            (!onlyWithoutValue || card.value === null)
          );
        });
      const at = selectedOpportunityId === null ? -1 : ids.indexOf(selectedOpportunityId);
      const next = ids[Math.min(ids.length - 1, Math.max(0, at === -1 ? (delta === 1 ? 0 : ids.length - 1) : at + delta))];
      const card = next === undefined ? undefined : board.cards[next];
      if (card !== undefined) onOpenFirm(card.firm.id, card.opportunityId);
      return;
    }
    const order = columns.flatMap((column) => visible(column).map((firm) => firm.id));
    if (order.length === 0) return;
    const at = selectedFirmId === null ? -1 : order.indexOf(selectedFirmId);
    const next = order[Math.min(order.length - 1, Math.max(0, at === -1 ? (delta === 1 ? 0 : order.length - 1) : at + delta))];
    if (next !== undefined) onOpenFirm(next);
  };
  useShortcuts({
    next: () => {
      walk(1);
    },
    previous: () => {
      walk(-1);
    },
    search: () => {
      searchBox.current?.focus();
      searchBox.current?.select();
    },
  });

  // Before the first paint, so the board never flashes at the left edge.
  useLayoutEffect(() => {
    if (scroller.current !== null) scroller.current.scrollLeft = memory.current.left;
    for (const [key, node] of columnNodes.current) node.scrollTop = memory.current.columns[key] ?? 0;
    // Once per mount: a later read of the board must not fight the person's own scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (pipeline.plural !== undefined)
    return (
      <PluralBoard
        pipeline={pipeline}
        actionsEnabled={actionsEnabled}
        stageBusy={stageBusy}
        valueBusy={valueBusy}
        search={search}
        memory={memory}
        onSearch={onSearch}
        onShowLost={onShowLost}
        onChangeStage={onChangeStage}
        onSetValue={onSetValue}
        onOpenFirm={onOpenFirm}
        selectedFirmId={selectedFirmId}
        selectedOpportunityId={selectedOpportunityId}
        refs={{ scroller, searchBox, columnNodes }}
        cardEditors={cardEditors}
        {...(onCardEditor === undefined ? {} : { onCardEditor })}
        feedback={feedback}
        onlyWithoutValue={onlyWithoutValue}
        {...(onOnlyWithoutValue === undefined ? {} : { onOnlyWithoutValue })}
      />
    );

  return (
    <div data-testid="pipeline-board" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-5 py-1.5">
        <div className="relative w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <Input
            ref={searchBox}
            data-testid="pipeline-search"
            type="search"
            aria-label="Search the board"
            placeholder="Search firms"
            autoComplete="off"
            value={search}
            onChange={(event) => {
              onSearch(event.target.value);
            }}
            className="h-7 border-border pl-7 text-sm"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            data-testid="show-lost"
            checked={includeLost}
            onChange={(event) => {
              onShowLost(event.target.checked);
            }}
          />
          Show lost
        </label>
        <p data-testid="board-totals" className="ml-auto flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>As of today</span>
          <span className="tabular-nums">{open.firms} open</span>
          {summary === '' ? null : <span className="tabular-nums">· {summary}</span>}
          {open.withoutValue === 0 ? null : onOnlyWithoutValue === undefined ? (
            <span data-testid="board-no-value" className="tabular-nums">
              · {open.withoutValue} without a value
            </span>
          ) : (
            <Button
              variant={onlyWithoutValue ? 'secondary' : 'quiet'}
              size="sm"
              data-testid="board-no-value"
              aria-pressed={onlyWithoutValue}
              title={onlyWithoutValue ? 'Show every firm again' : 'Show only the firms with no value yet'}
              className="h-6 px-1.5 tabular-nums"
              onClick={() => {
                onOnlyWithoutValue(!onlyWithoutValue);
              }}
            >
              {open.withoutValue} without a value
            </Button>
          )}
        </p>
      </div>
      {everyFirm === 0 && !includeLost ? (
        <EmptyState testId="board-empty" title="No firms are in the pipeline yet">
          A firm appears here once it has an open opportunity. Add one from Firms, or from a firm’s page.
        </EmptyState>
      ) : null}
      <div
        ref={scroller}
        data-testid="pipeline-scroller"
        className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4"
        onScroll={(event) => {
          memory.current.left = event.currentTarget.scrollLeft;
        }}
      >
        {columns.map((column) => {
          const firms = visible(column);
          const sums = totalsOf(firms.map((firm) => pipeline.cards?.[firm.id]));
          const money = valueSummary(sums);
          return (
            <section
              key={column.stage.key}
              data-testid="pipeline-column"
              data-stage-key={column.stage.key}
              aria-label={column.stage.displayName}
              className={cn(
                'flex min-h-0 w-[248px] shrink-0 flex-col rounded-lg bg-sidebar p-1.5 min-[1920px]:w-auto min-[1920px]:max-w-[360px] min-[1920px]:min-w-[280px] min-[1920px]:flex-1',
                column.stage.terminalKind === 'lost' && 'opacity-90',
              )}
            >
              <h2 className="flex min-h-8 items-baseline justify-between gap-2 px-1.5 pt-1.5 text-sm font-medium">
                <span className="flex items-baseline gap-1.5">
                  <span data-testid="pipeline-column-name">{column.stage.displayName}</span>
                  <small data-testid="pipeline-column-count" className="text-xs font-normal text-faint tabular-nums">
                    {firms.length}
                  </small>
                </span>
                {column.stage.retired ? (
                  <Chip tone="outline" data-testid="stage-retired">
                    retired
                  </Chip>
                ) : null}
              </h2>
              {money === '' ? null : (
                <p data-testid="pipeline-column-total" className="px-1.5 pb-1 text-xs text-muted-foreground tabular-nums">
                  {money}
                </p>
              )}
              <ul
                data-testid="pipeline-firms"
                ref={(node) => {
                  if (node === null) columnNodes.current.delete(column.stage.key);
                  else columnNodes.current.set(column.stage.key, node);
                }}
                className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto"
                onScroll={(event) => {
                  memory.current.columns[column.stage.key] = event.currentTarget.scrollTop;
                }}
              >
                {firms.length === 0 ? (
                  <li className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-faint">Nothing here.</li>
                ) : (
                  firms.map((firm) => {
                    const opportunityId = pipeline.opportunityIdByFirmId[firm.id];
                    return (
                      <BoardCard
                        key={firm.id}
                        firm={firm}
                        card={pipeline.cards?.[firm.id]}
                        stage={column.stage}
                        stages={pipeline.stages ?? pipeline.columns.map((column) => column.stage)}
                        opportunityId={opportunityId}
                        actionsEnabled={actionsEnabled}
                        stageBusy={opportunityId !== undefined && stageBusy(opportunityId)}
                        valueBusy={opportunityId !== undefined && valueBusy(opportunityId)}
                        onChangeStage={onChangeStage}
                        onSetValue={onSetValue}
                        onOpenFirm={onOpenFirm}
                        selected={selectedFirmId === firm.id}
                        {...(onCardEditor === undefined || opportunityId === undefined
                          ? {}
                          : {
                              editor: cardEditors[opportunityId] ?? null,
                              onEditor: (next: CardEditor | null) => {
                                onCardEditor(opportunityId, next);
                              },
                            })}
                        feedback={opportunityId === undefined ? undefined : feedback[opportunityId]}
                      />
                    );
                  })
                )}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function PluralBoard({
  pipeline,
  actionsEnabled,
  stageBusy,
  valueBusy,
  search,
  memory,
  onSearch,
  onShowLost,
  onChangeStage,
  onSetValue,
  onOpenFirm,
  selectedOpportunityId,
  refs,
  cardEditors = {},
  onCardEditor,
  feedback = {},
  onlyWithoutValue = false,
  onOnlyWithoutValue,
}: Parameters<typeof Board>[0] & {
  refs: {
    scroller: MutableRefObject<HTMLDivElement | null>;
    searchBox: MutableRefObject<HTMLInputElement | null>;
    columnNodes: MutableRefObject<Map<string, HTMLElement>>;
  };
}): JSX.Element {
  const board = pipeline.plural;
  if (board === undefined) throw new Error('plural board required');
  const needle = search.trim().toLowerCase();
  const totals = openTotals(pipeline);
  const summary = valueSummary(totals);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-5 py-3">
        <Input
          ref={refs.searchBox}
          aria-label="Search the board"
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search firms and deals"
        />
        <label>
          <input type="checkbox" checked={pipeline.includeLost === true} onChange={(event) => onShowLost(event.target.checked)} /> Show lost
        </label>
        <p data-testid="board-totals">
          Open opportunities: {totals.firms}
          {summary ? ` · ${summary}` : ''}
        </p>
        {onOnlyWithoutValue ? (
          <Button onClick={() => onOnlyWithoutValue(!onlyWithoutValue)} aria-pressed={onlyWithoutValue}>
            {totals.withoutValue} without a value
          </Button>
        ) : null}
      </div>
      <div
        ref={refs.scroller}
        className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5"
        onScroll={(event) => {
          memory.current.left = event.currentTarget.scrollLeft;
        }}
      >
        {board.columns.map((column) => (
          <section key={column.stage.id} className="flex w-[260px] shrink-0 flex-col rounded-lg bg-sidebar p-2">
            <h2>
              {column.stage.displayName} · {column.opportunityIds.length}
            </h2>
            <ul
              ref={(node) => {
                if (node === null) refs.columnNodes.current.delete(column.stage.key);
                else refs.columnNodes.current.set(column.stage.key, node);
              }}
              className="min-h-0 overflow-y-auto"
              onScroll={(event) => {
                memory.current.columns[column.stage.key] = event.currentTarget.scrollTop;
              }}
            >
              {column.opportunityIds.map((id) => {
                const card = board.cards[id];
                if (
                  card === undefined ||
                  (needle && !`${card.firm.name} ${card.displayName ?? ''}`.toLowerCase().includes(needle)) ||
                  (onlyWithoutValue && card.value !== null)
                )
                  return null;
                return (
                  <BoardCard
                    key={id}
                    dealLabel={
                      card.displayName ??
                      `Deal opened ${card.firm.openedAt === null ? 'previously' : new Date(card.firm.openedAt).toLocaleString()}`
                    }
                    firm={card.firm}
                    card={card}
                    stage={column.stage}
                    stages={board.stages}
                    opportunityId={card.mayChangeStage ? id : undefined}
                    actionsEnabled={actionsEnabled}
                    stageBusy={stageBusy(id)}
                    valueBusy={valueBusy(id)}
                    onChangeStage={onChangeStage}
                    onSetValue={onSetValue}
                    onOpenFirm={(firmId) => onOpenFirm(firmId, id)}
                    selected={selectedOpportunityId === id}
                    {...(onCardEditor === undefined
                      ? {}
                      : { editor: cardEditors[id] ?? null, onEditor: (next: CardEditor | null) => onCardEditor(id, next) })}
                    feedback={feedback[id]}
                  />
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
