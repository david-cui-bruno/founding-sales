import type { CellContext, ColumnDef, ColumnMeta } from '@tanstack/react-table';
import { useOverlayLayers } from '../../app/overlayLayers';
import type { InlineEditor, LeadSaveResult } from './useLeadMutations';

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
import { Button } from '../../components/Button';
import { Avatar } from '../../components/Avatar';
import { StatusPill } from '../../components/StatusPill';
import { formatCloudChip } from './cloudSignalLabels';

/** Muted placeholder for data that is physically absent pre-prioritization. */
export const ABSENT_PLACEHOLDER = '—';

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
  editor: InlineEditor;
  onUpdateField(input: LeadFieldUpdateRequest): Promise<LeadSaveResult>;
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

type InlineEditProps = {
  editor: InlineEditor;
  onUpdateField(input: LeadFieldUpdateRequest): Promise<LeadSaveResult>;
};
function submitInline({ editor, onUpdateField }: InlineEditProps) {
  const session = editor.session;
  if (!session || editor.pending) return;
  const value = session.draft.trim();
  if (session.field === 'person_name') {
    if (value) void onUpdateField({ personId: session.personId, field: 'person_name', value });
  } else void onUpdateField({ personId: session.personId, field: 'organization_label', value: value || null });
}

/** One input lives in either its visible row or the external recovery panel. */
export function InlineTextEdit(props: InlineEditProps) {
  const { editor } = props;
  const layers = useOverlayLayers();
  const session = editor.session;
  if (!session) return null;
  return <input className="leads-grid__edit" type="text"
    ref={node => editor.bindInput(node, !layers.hasModal())}
    aria-label={`Edit ${session.field === 'person_name' ? 'name' : 'organization'} for ${session.personLabel}`}
    value={session.draft} readOnly={editor.pending}
    onChange={event => editor.change(event.target.value)}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape' && layers.hasOpenLayer()) return;
      event.stopPropagation();
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat || layers.hasModal()) return;
      if (event.key === 'Enter') { event.preventDefault(); submitInline(props); }
      else if (event.key === 'Escape' && !editor.pending) editor.cancel();
    }} />;
}

/** Actions and safe feedback never compete for space inside a fixed-height row. */
export function InlineEditPanel({ recovery = false, ...props }: InlineEditProps & { recovery?: boolean }) {
  const { editor } = props;
  const layers = useOverlayLayers();
  const session = editor.session;
  if (!session) return null;
  return <section className="leads-edit-panel" aria-label="Unfinished edit">
    <h3>Unfinished edit</h3>
    <p>{session.personLabel} · {session.field === 'person_name' ? 'Name' : 'Organization'}</p>
    {recovery && <InlineTextEdit {...props} />}
    <div className="leads-edit-panel__actions">
      <Button variant="quiet" disabled={editor.pending} onClick={() => { if (!layers.hasModal()) editor.focusInput(); }}>Resume edit</Button>
      <Button disabled={editor.pending} onClick={() => submitInline(props)}>Save edit</Button>
      <Button variant="quiet" disabled={editor.pending} onClick={() => editor.cancel()}>Cancel edit</Button>
    </div>
    {session.error && <p className="leads-edit-panel__error" role="alert">{session.error}</p>}
  </section>;
}

const gridMeta = (context: CellContext<LeadRow, unknown>): LeadsGridMeta =>
  context.table.options.meta as LeadsGridMeta;

function PersonCell(context: CellContext<LeadRow, unknown>) {
  const meta = gridMeta(context);
  const lead = context.row.original;
  const editing =
    meta.editor.session !== null &&
    meta.editor.session.personId === lead.personId &&
    meta.editor.session.field === 'person_name';

  return (
    <div className="leads-grid__person">
      {meta.onToggleChecked !== undefined && (
        <input
          type="checkbox"
          className="leads-grid__check"
          aria-label={`Select ${lead.personName}`}
          checked={meta.checkedPersonIds?.has(lead.personId) ?? false}
          disabled={meta.editor.pending}
          onClick={(event) => event.stopPropagation()}
          onChange={() => meta.onToggleChecked?.(lead.personId)}
        />
      )}
      <Avatar name={lead.personName} />
      {editing ? (
        <InlineTextEdit editor={meta.editor} onUpdateField={meta.onUpdateField} />
      ) : (
        <span
          className="leads-grid__name"
          onClick={event => event.stopPropagation()}
          onDoubleClick={() =>
            meta.editor.start({ personId: lead.personId, field: 'person_name', personLabel: lead.personName, draft: lead.personName })
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
    meta.editor.session !== null &&
    meta.editor.session.personId === lead.personId &&
    meta.editor.session.field === 'organization_label';

  if (editing) {
    return (
      <div className="leads-grid__context">
        <InlineTextEdit editor={meta.editor} onUpdateField={meta.onUpdateField} />
      </div>
    );
  }

  const startOrganizationEdit = () =>
    meta.editor.start({ personId: lead.personId, field: 'organization_label', personLabel: lead.personName, draft: lead.organization ?? '' });

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
          onClick={event => event.stopPropagation()}
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
      onClick={event => event.stopPropagation()}
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
