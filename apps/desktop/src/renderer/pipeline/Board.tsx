import { useLayoutEffect, useRef, type JSX, type MutableRefObject } from 'react';
import type { PipelineView, StageChange, ValueChange } from '../firmWorkspaceContract.ts';
import { Input } from '../ui/input.tsx';
import { Tag } from '../ui/layout.tsx';
import { BoardCard } from './BoardCard.tsx';

/**
 * The Kanban (slice K): one column per board stage, in the board's order, each scrolling
 * on its own, the whole board scrolling sideways. The columns are the API's, not a
 * hard-coded five: a renamed stage is renamed here, a retired and empty one is hidden, and
 * Lost is there only while the "Show lost" filter asked for it.
 *
 * **The board keeps its place.** Opening a firm replaces this view with the firm's page and
 * closing it draws the board again from a fresh read, so the search text and the scroll
 * offsets live with the caller (`BoardMemory`), which outlives both, and are put back
 * before the first paint.
 */

export interface BoardMemory {
  /** Horizontal offset of the board, and each column's vertical offset by stage key. */
  left: number;
  columns: Record<string, number>;
}

export const emptyBoardMemory = (): BoardMemory => ({ left: 0, columns: {} });

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
  onOpenFirm(firmId: string): void;
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null);
  const columnNodes = useRef(new Map<string, HTMLElement>());
  const needle = search.trim().toLowerCase();
  const columns = pipeline.columns
    // A retired stage with nothing in it is history nobody needs on screen.
    .filter(column => !(column.stage.retired && column.firms.length === 0));
  const includeLost = pipeline.includeLost === true;

  // Before the first paint, so the board never flashes at the left edge.
  useLayoutEffect(() => {
    if (scroller.current !== null) scroller.current.scrollLeft = memory.current.left;
    for (const [key, node] of columnNodes.current) node.scrollTop = memory.current.columns[key] ?? 0;
    // Once per mount: a later read of the board must not fight the person's own scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-testid="pipeline-board" className="mt-6 flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <Input
          data-testid="pipeline-search"
          type="search"
          aria-label="Search the board"
          placeholder="Search firms"
          autoComplete="off"
          value={search}
          onChange={event => {
            onSearch(event.target.value);
          }}
          className="h-7 w-56 text-xs"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            data-testid="show-lost"
            checked={includeLost}
            onChange={event => {
              onShowLost(event.target.checked);
            }}
          />
          Show lost
        </label>
      </div>
      <div
        ref={scroller}
        data-testid="pipeline-scroller"
        className="flex gap-3 overflow-x-auto pb-3"
        onScroll={event => {
          memory.current.left = event.currentTarget.scrollLeft;
        }}
      >
        {columns.map(column => {
          const firms = column.firms.filter(firm => needle === '' || firm.name.toLowerCase().includes(needle));
          return (
            <section
              key={column.stage.key}
              data-testid="pipeline-column"
              data-stage-key={column.stage.key}
              aria-label={column.stage.displayName}
              className="flex w-64 shrink-0 flex-col"
            >
              <h2 className="mb-1 flex items-baseline justify-between gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                <span className="flex items-baseline gap-1.5">
                  <span data-testid="pipeline-column-name">{column.stage.displayName}</span>
                  <small data-testid="pipeline-column-count" className="text-[11px] font-normal">
                    {firms.length}
                  </small>
                </span>
                {column.stage.retired ? <Tag data-testid="stage-retired">retired</Tag> : null}
              </h2>
              <ul
                data-testid="pipeline-firms"
                ref={node => {
                  if (node === null) columnNodes.current.delete(column.stage.key);
                  else columnNodes.current.set(column.stage.key, node);
                }}
                className="flex max-h-[calc(100vh-15rem)] flex-col overflow-y-auto border-t border-border"
                onScroll={event => {
                  memory.current.columns[column.stage.key] = event.currentTarget.scrollTop;
                }}
              >
                {firms.length === 0 ? (
                  <li className="py-2 text-sm text-muted-foreground">Nothing here.</li>
                ) : (
                  firms.map(firm => {
                    const opportunityId = pipeline.opportunityIdByFirmId[firm.id];
                    return (
                      <BoardCard
                        key={firm.id}
                        firm={firm}
                        card={pipeline.cards?.[firm.id]}
                        stage={column.stage}
                        stages={pipeline.stages ?? pipeline.columns.map(column => column.stage)}
                        opportunityId={opportunityId}
                        actionsEnabled={actionsEnabled}
                        stageBusy={opportunityId !== undefined && stageBusy(opportunityId)}
                        valueBusy={opportunityId !== undefined && valueBusy(opportunityId)}
                        onChangeStage={onChangeStage}
                        onSetValue={onSetValue}
                        onOpenFirm={onOpenFirm}
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
