import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import type {
  LeadFieldUpdateRequest,
  LeadRow,
  LeadsListRequest,
} from '../../../shared/contracts/leadsContract';
import {
  createLeadColumns,
  InlineEditPanel,
  type LeadColumnMeta,
  type LeadsGridMeta,
} from './leadColumns';
import type { InlineEditor, LeadSaveResult } from './useLeadMutations';

export type LeadsGridProps = {
  rows: LeadRow[];
  selectedPersonId: string | null;
  onSelect(personId: string): void;
  editor: InlineEditor;
  onUpdateField(input: LeadFieldUpdateRequest): Promise<LeadSaveResult>;
  onOpenLead?(personId: string): void;
  checkedPersonIds?: ReadonlySet<string>;
  onToggleChecked?(personId: string): void;
  /** Current server sort; drives aria-sort on sortable column headers. */
  sort?: LeadsListRequest['sort'];
  /** Requests a contract-supported server sort from a column header. */
  onSortChange?(sort: LeadsListRequest['sort']): void;
};

const ROW_HEIGHT = 46;

/**
 * Controlled, virtualized, person-first grid. TanStack Table owns column
 * state; TanStack Virtual renders only the visible row window. Selection,
 * checking, sorting, and edits all flow up through props. The header row is
 * sticky inside the scroll container, so it stays pinned under the page
 * header while the rows scroll.
 */
export function LeadsGrid({
  rows,
  selectedPersonId,
  onSelect,
  onUpdateField,
  editor,
  onOpenLead,
  checkedPersonIds,
  onToggleChecked,
  sort,
  onSortChange,
}: LeadsGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Roving focus: after a keyboard move, focus follows the newly selected row
  // once it exists in the (virtualized) DOM.
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);

  const columns = useMemo(() => createLeadColumns(), []);
  const meta: LeadsGridMeta = {
    editor,
    onUpdateField,
    checkedPersonIds,
    onToggleChecked,
  };

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.personId,
    meta,
  });

  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  useEffect(() => {
    if (pendingFocusId === null) {
      return;
    }
    const row = Array.from(
      bodyRef.current?.querySelectorAll<HTMLElement>('[data-person-id]') ?? [],
    ).find((element) => element.dataset['personId'] === pendingFocusId);
    if (row !== undefined) {
      row.focus();
      setPendingFocusId(null);
    }
  }, [pendingFocusId, selectedPersonId]);

  const moveSelection = (fromPersonId: string, delta: number) => {
    if (editor.pending) return;
    const index = tableRows.findIndex((row) => row.id === fromPersonId);
    if (index === -1) {
      return;
    }
    const next = tableRows[index + delta];
    if (next !== undefined) {
      onSelect(next.id);
      virtualizer.scrollToIndex(index + delta);
      setPendingFocusId(next.id);
    }
  };

  const onRowKeyDown = (event: KeyboardEvent, personId: string) => {
    if (
      event.target !== event.currentTarget ||
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
      case 'j':
      case 'J':
        event.preventDefault();
        moveSelection(personId, 1);
        break;
      case 'ArrowUp':
      case 'k':
      case 'K':
        event.preventDefault();
        moveSelection(personId, -1);
        break;
      case 'Enter':
        if (editor.pending) return;
        event.preventDefault();
        onOpenLead?.(personId);
        break;
      default:
        break;
    }
  };

  return (
    <>
    <div className="leads-grid" role="grid" aria-label="Leads" aria-rowcount={rows.length + 1}>
      <div className="leads-grid__scroll" ref={scrollRef}>
        <div className="leads-grid__head" role="row" aria-rowindex={1}>
          {table.getFlatHeaders().map((header) => {
            const columnSort = (header.column.columnDef.meta as
              | LeadColumnMeta
              | undefined)?.sort;
            const sortable = columnSort !== undefined && onSortChange !== undefined;
            const active = sortable && sort === columnSort.value;
            return (
              <div
                key={header.id}
                role="columnheader"
                aria-sort={
                  sortable ? (active ? columnSort.direction : 'none') : undefined
                }
                className={`leads-grid__header leads-grid__col--${header.column.id}`}
              >
                {sortable ? (
                  <button
                    type="button"
                    className={
                      active
                        ? 'leads-grid__sort leads-grid__sort--active'
                        : 'leads-grid__sort'
                    }
                    onClick={() => onSortChange(columnSort.value)}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {active && (
                      <span className="leads-grid__sort-arrow" aria-hidden="true">
                        {columnSort.direction === 'ascending' ? (
                          <ChevronUp size={12} />
                        ) : (
                          <ChevronDown size={12} />
                        )}
                      </span>
                    )}
                  </button>
                ) : (
                  flexRender(header.column.columnDef.header, header.getContext())
                )}
              </div>
            );
          })}
        </div>
        <div
          className="leads-grid__body"
          ref={bodyRef}
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = tableRows[virtualRow.index];
            if (row === undefined) {
              return null;
            }
            const lead = row.original;
            const selected = lead.personId === selectedPersonId;
            return (
              <div
                key={row.id}
                role="row"
                aria-rowindex={virtualRow.index + 2}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-person-id={lead.personId}
                className={
                  selected
                    ? 'leads-grid__row leads-grid__row--selected'
                    : 'leads-grid__row'
                }
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                onClick={() => {
                  // A plain row click both selects and opens the inspector.
                  // Checkbox and inline-edit clicks stopPropagation upstream,
                  // so they stay select/edit-only.
                  if (editor.pending) return;
                  onSelect(lead.personId);
                  onOpenLead?.(lead.personId);
                }}
                onKeyDown={(event) => onRowKeyDown(event, lead.personId)}
              >
                {row.getVisibleCells().map((cell) => {
                  const numeric =
                    (cell.column.columnDef.meta as LeadColumnMeta | undefined)
                      ?.numeric === true;
                  return (
                    <div
                      key={cell.id}
                      role="gridcell"
                      className={`leads-grid__cell leads-grid__col--${cell.column.id}${numeric ? ' numeric' : ''}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
    {editor.session && <InlineEditPanel editor={editor} onUpdateField={onUpdateField}
      recovery={!virtualizer.getVirtualItems().some(item => tableRows[item.index]?.id === editor.session?.personId)} />}
    </>
  );
}
