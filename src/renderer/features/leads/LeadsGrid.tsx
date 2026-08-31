import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import type {
  LeadFieldUpdateRequest,
  LeadRow,
} from '../../../shared/contracts/leadsContract';
import {
  createLeadColumns,
  type EditingCell,
  type LeadsGridMeta,
} from './leadColumns';

export type LeadsGridProps = {
  rows: LeadRow[];
  selectedPersonId: string | null;
  onSelect(personId: string): void;
  onUpdateField(input: LeadFieldUpdateRequest): void;
  onOpenLead?(personId: string): void;
  checkedPersonIds?: ReadonlySet<string>;
  onToggleChecked?(personId: string): void;
};

const ROW_HEIGHT = 46;

/**
 * Controlled, virtualized, person-first grid. TanStack Table owns column
 * state; TanStack Virtual renders only the visible row window. Selection,
 * checking, and edits all flow up through props.
 */
export function LeadsGrid({
  rows,
  selectedPersonId,
  onSelect,
  onUpdateField,
  onOpenLead,
  checkedPersonIds,
  onToggleChecked,
}: LeadsGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);

  const columns = useMemo(() => createLeadColumns(), []);
  const meta: LeadsGridMeta = {
    editing,
    startEdit: (cell) => setEditing(cell),
    stopEdit: () => setEditing(null),
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

  const moveSelection = (fromPersonId: string, delta: number) => {
    const index = tableRows.findIndex((row) => row.id === fromPersonId);
    if (index === -1) {
      return;
    }
    const next = tableRows[index + delta];
    if (next !== undefined) {
      onSelect(next.id);
      virtualizer.scrollToIndex(index + delta);
    }
  };

  const onRowKeyDown = (event: KeyboardEvent, personId: string) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(personId, 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(personId, -1);
        break;
      case 'Enter':
        event.preventDefault();
        onOpenLead?.(personId);
        break;
      default:
        break;
    }
  };

  return (
    <div className="leads-grid" role="grid" aria-label="Leads" aria-rowcount={rows.length + 1}>
      <div className="leads-grid__head" role="row" aria-rowindex={1}>
        {table.getFlatHeaders().map((header) => (
          <div
            key={header.id}
            role="columnheader"
            className={`leads-grid__header leads-grid__col--${header.column.id}`}
          >
            {flexRender(header.column.columnDef.header, header.getContext())}
          </div>
        ))}
      </div>
      <div className="leads-grid__scroll" ref={scrollRef}>
        <div
          className="leads-grid__body"
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
                className={
                  selected
                    ? 'leads-grid__row leads-grid__row--selected'
                    : 'leads-grid__row'
                }
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                onClick={() => onSelect(lead.personId)}
                onKeyDown={(event) => onRowKeyDown(event, lead.personId)}
              >
                {row.getVisibleCells().map((cell) => (
                  <div
                    key={cell.id}
                    role="gridcell"
                    className={`leads-grid__cell leads-grid__col--${cell.column.id}`}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
