import type { CellContext, ColumnDef, ColumnMeta } from '@tanstack/react-table';
import { useState } from 'react';

import type {
  LeadPriorityContext,
  LifecycleStage,
  PrimaryAction,
} from '../../../shared/contracts/commonContract';
import type {
  CloudScoreChip,
  LeadFieldUpdateRequest,
  LeadRow,
  LeadsListRequest,
} from '../../../shared/contracts/leadsContract';
import { titleCaseDisplayName } from '../../../shared/displayText';
import { Avatar } from '../../components/Avatar';
import { StatusPill } from '../../components/StatusPill';
import { formatCloudChip } from './cloudSignalLabels';

/** Muted placeholder for data that is physically absent pre-prioritization. */
export const ABSENT_PLACEHOLDER = '—';

export type EditingCell = {
  personId: string;
  field: 'person_name' | 'organization_label';
};

/**
 * Per-column presentation metadata. `sort` appears only on columns whose
 * ordering the leads:list contract actually supports (person_name, due_at,
 * last_contact); every other header stays a plain label. The composite
 * priority sort lives in the toolbar Select. `direction` mirrors the fixed
 * server ORDER BY direction for aria-sort.
 */
export type LeadColumnMeta = {
  sort?: {
    value: LeadsListRequest['sort'];
    direction: 'ascending' | 'descending';
  };
  numeric?: boolean;
};

const columnMeta = (meta: LeadColumnMeta): ColumnMeta<LeadRow, unknown> =>
  meta as ColumnMeta<LeadRow, unknown>;

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
  // Decorative placeholder: faint per the audit, hidden from screen readers
  // (an empty cell reads better than "em dash").
  return (
    <span className="leads-grid__absent" aria-hidden="true">
      {ABSENT_PLACEHOLDER}
    </span>
  );
}

/**
 * Cloud score chip: the two cloud axes side by side ("Fit 62 · Timing 41"),
 * indigo accent, never merged into one number. A zero-signal chip
 * (fit 0 AND timing 0) renders in the muted variant: it is real scorer
 * output, but the indigo accent would overstate it.
 */
export function CloudScoreChipBadge({ scores }: { scores: CloudScoreChip }) {
  const zeroSignal = scores.fit === 0 && scores.timing === 0;
  const className = zeroSignal
    ? 'leads-grid__cloud-chip leads-grid__cloud-chip--zero'
    : 'leads-grid__cloud-chip';
  return (
    <span className={className} aria-label="Cloud scores">
      {formatCloudChip(scores)}
    </span>
  );
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
          {titleCaseDisplayName(lead.personName)}
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

  if (editing) {
    return (
      <div className="leads-grid__context">
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
      </div>
    );
  }

  const startOrganizationEdit = () =>
    meta.startEdit({ personId: lead.personId, field: 'organization_label' });

  // Audit rule: organization leads only when it is real, distinct context.
  // An org that merely repeats the person's name collapses to the address,
  // and a missing org renders a single line — never a leading em-dash.
  const organization = lead.organization?.trim() ?? '';
  const showOrganization =
    organization !== '' &&
    organization.toLowerCase() !== lead.personName.trim().toLowerCase();
  const address = lead.propertySummary;

  if (showOrganization) {
    const title =
      address === null ? organization : `${organization} · ${address}`;
    return (
      <div className="leads-grid__context" title={title}>
        <span
          className="leads-grid__organization"
          onDoubleClick={startOrganizationEdit}
        >
          {lead.organization}
        </span>
        {address !== null && (
          <span className="leads-grid__property">{address}</span>
        )}
      </div>
    );
  }

  return (
    <div
      className="leads-grid__context leads-grid__context--single"
      title={address ?? undefined}
      onDoubleClick={startOrganizationEdit}
    >
      {address !== null && (
        <span className="leads-grid__property">{address}</span>
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
    {
      id: 'person',
      header: 'Person',
      cell: PersonCell,
      meta: columnMeta({
        sort: { value: 'person_name', direction: 'ascending' },
      }),
    },
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
      meta: columnMeta({ numeric: true }),
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
      meta: columnMeta({ numeric: true }),
      cell: (context) =>
        context.row.original.priorityContext === null ? (
          <Absent />
        ) : (
          formatTiming(context.row.original.priorityContext)
        ),
    },
    {
      id: 'cloudScores',
      header: 'Cloud',
      cell: (context) =>
        context.row.original.cloudScores === null ? (
          <Absent />
        ) : (
          <CloudScoreChipBadge scores={context.row.original.cloudScores} />
        ),
    },
    {
      id: 'nextAction',
      header: 'Next action',
      meta: columnMeta({
        sort: { value: 'due_at', direction: 'ascending' },
      }),
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
      meta: columnMeta({
        sort: { value: 'last_contact', direction: 'descending' },
        numeric: true,
      }),
      cell: (context) =>
        context.row.original.lastActivityAt === null ? (
          <Absent />
        ) : (
          formatLastActivity(context.row.original.lastActivityAt)
        ),
    },
  ];
}
