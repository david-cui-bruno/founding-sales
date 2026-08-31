import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';

import type {
  LeadPriorityContext,
  LifecycleStage,
  PrimaryAction,
} from '../../../shared/contracts/commonContract';
import type {
  LeadFieldUpdateRequest,
  LeadRow,
} from '../../../shared/contracts/leadsContract';
import { Avatar } from '../../components/Avatar';
import { StatusPill } from '../../components/StatusPill';

/** Muted placeholder for data that is physically absent pre-prioritization. */
export const ABSENT_PLACEHOLDER = '—';

export type EditingCell = {
  personId: string;
  field: 'person_name' | 'organization_label';
};

/** Live callbacks the grid passes to cells through the table meta option. */
export type LeadsGridMeta = {
  editing: EditingCell | null;
  startEdit(cell: EditingCell): void;
  stopEdit(): void;
  onUpdateField(input: LeadFieldUpdateRequest): void;
  checkedPersonIds?: ReadonlySet<string>;
  onToggleChecked?(personId: string): void;
};

const capitalize = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);

/** Renders fractional timing values compactly: 31 -> "31", 31.25 -> "31.3". */
export const formatPoints = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

/** Fit stays its own readout, e.g. "High · 24/30". Never blended with timing. */
export const formatFit = (context: LeadPriorityContext | null): string =>
  context === null
    ? ABSENT_PLACEHOLDER
    : `${capitalize(context.fitBand)} · ${formatPoints(context.fitPoints)}/30`;

/** Timing stays its own readout, e.g. "Hot · 31/40". Never blended with fit. */
export const formatTiming = (context: LeadPriorityContext | null): string =>
  context === null
    ? ABSENT_PLACEHOLDER
    : `${capitalize(context.timingBand)} · ${formatPoints(context.timingValue)}/40`;

export const STAGE_LABELS: Readonly<Record<LifecycleStage, string>> = Object.freeze({
  unreviewed: 'Unreviewed',
  ready: 'Ready',
  contacted: 'Contacted',
  interviewed: 'Interviewed',
  offered: 'Offered',
  won: 'Won',
  lost_nurture: 'Lost · Nurture',
});

export const formatNextAction = (action: PrimaryAction | null): string =>
  action === null ? ABSENT_PLACEHOLDER : action.label;

export const formatLastActivity = (isoTimestamp: string | null): string => {
  if (isoTimestamp === null) {
    return ABSENT_PLACEHOLDER;
  }
  return new Date(isoTimestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
};

function Absent() {
  return <span className="leads-grid__absent">{ABSENT_PLACEHOLDER}</span>;
}

type InlineTextEditProps = {
  label: string;
  initialValue: string;
  onCommit(value: string): void;
  onCancel(): void;
};

function InlineTextEdit({
  label,
  initialValue,
  onCommit,
  onCancel,
}: InlineTextEditProps) {
  const [value, setValue] = useState(initialValue);

  return (
    <input
      className="leads-grid__edit"
      type="text"
      aria-label={label}
      value={value}
      autoFocus
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          onCommit(value);
        } else if (event.key === 'Escape') {
          onCancel();
        }
      }}
      onBlur={onCancel}
    />
  );
}

const gridMeta = (context: CellContext<LeadRow, unknown>): LeadsGridMeta =>
  context.table.options.meta as LeadsGridMeta;

function PersonCell(context: CellContext<LeadRow, unknown>) {
  const meta = gridMeta(context);
  const lead = context.row.original;
  const editing =
    meta.editing !== null &&
    meta.editing.personId === lead.personId &&
    meta.editing.field === 'person_name';

  return (
    <div className="leads-grid__person">
      {meta.onToggleChecked !== undefined && (
        <input
          type="checkbox"
          className="leads-grid__check"
          aria-label={`Select ${lead.personName}`}
          checked={meta.checkedPersonIds?.has(lead.personId) ?? false}
          onClick={(event) => event.stopPropagation()}
          onChange={() => meta.onToggleChecked?.(lead.personId)}
        />
      )}
      <Avatar name={lead.personName} />
      {editing ? (
        <InlineTextEdit
          label={`Edit name for ${lead.personName}`}
          initialValue={lead.personName}
          onCommit={(value) => {
            const trimmed = value.trim();
            if (trimmed.length > 0 && trimmed !== lead.personName) {
              meta.onUpdateField({
                personId: lead.personId,
                field: 'person_name',
                value: trimmed,
              });
            }
            meta.stopEdit();
          }}
          onCancel={meta.stopEdit}
        />
      ) : (
        <span
          className="leads-grid__name"
          onDoubleClick={() =>
            meta.startEdit({ personId: lead.personId, field: 'person_name' })
          }
        >
          {lead.personName}
        </span>
      )}
    </div>
  );
}

function ContextCell(context: CellContext<LeadRow, unknown>) {
  const meta = gridMeta(context);
  const lead = context.row.original;
  const editing =
    meta.editing !== null &&
    meta.editing.personId === lead.personId &&
    meta.editing.field === 'organization_label';

  return (
    <div className="leads-grid__context">
      {editing ? (
        <InlineTextEdit
          label={`Edit organization for ${lead.personName}`}
          initialValue={lead.organization ?? ''}
          onCommit={(value) => {
            const trimmed = value.trim();
            const next = trimmed === '' ? null : trimmed;
            if (next !== lead.organization) {
              meta.onUpdateField({
                personId: lead.personId,
                field: 'organization_label',
                value: next,
              });
            }
            meta.stopEdit();
          }}
          onCancel={meta.stopEdit}
        />
      ) : (
        <span
          className={
            lead.organization === null
              ? 'leads-grid__organization leads-grid__absent'
              : 'leads-grid__organization'
          }
          onDoubleClick={() =>
            meta.startEdit({
              personId: lead.personId,
              field: 'organization_label',
            })
          }
        >
          {lead.organization ?? ABSENT_PLACEHOLDER}
        </span>
      )}
      {lead.propertySummary !== null && (
        <span className="leads-grid__property">{lead.propertySummary}</span>
      )}
    </div>
  );
}

/**
 * Person-first column order. Fit and Timing stay separate readouts and none
 * of the headers is a clickable combined rank.
 */
export function createLeadColumns(): ColumnDef<LeadRow>[] {
  return [
    { id: 'person', header: 'Person', cell: PersonCell },
    { id: 'context', header: 'Context', cell: ContextCell },
    {
      id: 'lifecycle',
      header: 'Lifecycle',
      cell: (context) => (
        <StatusPill>{STAGE_LABELS[context.row.original.stage]}</StatusPill>
      ),
    },
    {
      id: 'fit',
      header: 'Fit',
      cell: (context) =>
        context.row.original.priorityContext === null ? (
          <Absent />
        ) : (
          formatFit(context.row.original.priorityContext)
        ),
    },
    {
      id: 'timing',
      header: 'Timing',
      cell: (context) =>
        context.row.original.priorityContext === null ? (
          <Absent />
        ) : (
          formatTiming(context.row.original.priorityContext)
        ),
    },
    {
      id: 'nextAction',
      header: 'Next action',
      cell: (context) =>
        context.row.original.nextAction === null ? (
          <Absent />
        ) : (
          formatNextAction(context.row.original.nextAction)
        ),
    },
    {
      id: 'lastActivity',
      header: 'Last activity',
      cell: (context) =>
        context.row.original.lastActivityAt === null ? (
          <Absent />
        ) : (
          formatLastActivity(context.row.original.lastActivityAt)
        ),
    },
  ];
}
