import type { RepositoryContext } from '../db/workspaceScope.ts';
import { firmIdentityDtoOf, type FirmIdentityDto } from './dto.ts';
import { listPipelineStages } from './pipeline.ts';
import type { FirmRow, PipelineStageRow } from './types.ts';
import type { MeetingState } from '@fss/contracts';

/**
 * The pipeline board, as one read (specification 8.1, Appendix F, Appendix G 7).
 *
 * G6 found the gap this closes and wrote it down in
 * `docs/decisions/g6-pipeline-board-opportunity-ids.md`: the board's firms come from
 * `GET /firms`, which returns `FirmIdentityDto`, and an identity carries the open
 * opportunity's *stage* but not its id. `POST /opportunities/stage` takes an id, so
 * the board could offer a stage change only for a firm whose page had already been
 * opened. G6 offered three resolutions and said it had no preference it could justify
 * from the specification. This is the choice; `docs/decisions/g9-pipeline-board-read.md`
 * is the argument.
 *
 * The short version: the id is carried by a board-specific read rather than added to
 * the identity DTO, and it is carried **only for the firms the caller could actually
 * change**. An admin gets every id; a salesperson gets the ids of their own firms and
 * nothing else. A colleague's column renders G3b's `stage-change-unavailable`, which
 * is honest — the mutation would be refused under the firm's row lock anyway — and it
 * is strictly narrower than Appendix F's first row, so the question of whether a
 * mutation handle belongs in the colleague-visible read does not have to be answered
 * at all.
 *
 * It is one read rather than one per column: N firm-page reads would also be N access
 * audit events for an admin (5.2), and a board load is not N sensitive reads.
 */

export interface PipelineBoardColumn {
  readonly stage: {
    readonly id: string;
    readonly key: string;
    readonly displayName: string;
    readonly position: number;
    readonly terminalKind: 'won' | 'lost' | null;
    readonly retired: boolean;
  };
  readonly firms: readonly FirmIdentityDto[];
}

/** What a card shows beyond the firm's identity (call-to-booking slice W). */
export interface PipelineBoardCard {
  readonly value: { readonly monthlyCents: number; readonly kind: 'estimated' | 'agreed' } | null;
  readonly meeting: { readonly meetingId: string; readonly state: MeetingState; readonly startsAt: string } | null;
  /**
   * The evidence of the opportunity's **latest** stage move, when that move was automatic
   * (Kanban slice K). A later manual move or close hides an earlier automatic move's
   * evidence: the card must not say "moved by a booking" about a stage a person chose.
   */
  readonly evidence: {
    readonly kind: string;
    readonly evidenceId: string;
    readonly occurredAt: string;
    readonly fromStageKey: string | null;
  } | null;
  readonly pinned: boolean;
  /** Why the opportunity was lost, for a Lost card; null otherwise. */
  readonly closeReason: string | null;
}

export interface PipelineBoardDto {
  readonly columns: readonly PipelineBoardColumn[];
  /**
   * The open opportunity id per firm, for the firms this caller may change. Sparse by
   * design; a firm absent from it is a firm whose column offers no stage control.
   */
  readonly opportunityIdByFirmId: Readonly<Record<string, string>>;
  /** Firms in no column: no opportunity, or a Lost one while the Lost filter is off. */
  readonly unplacedFirms: readonly FirmIdentityDto[];
  /**
   * Every stage of the workspace, in order, with Lost and retired ones: the destinations a
   * card's "Move to…" may name even while the Lost column is behind its filter.
   */
  readonly stages: readonly PipelineBoardColumn['stage'][];
  /** Card detail for every placed firm. */
  readonly cards: Readonly<Record<string, PipelineBoardCard>>;
}

function columnOf(stage: PipelineStageRow, firms: readonly FirmIdentityDto[]): PipelineBoardColumn {
  return {
    stage: {
      id: stage.id,
      key: stage.key,
      displayName: stage.display_name,
      position: stage.position,
      terminalKind: stage.terminal_kind,
      retired: stage.retired,
    },
    firms: firms.filter(firm => firm.stageKey === stage.key),
  };
}

type BoardRow = FirmRow & {
  readonly stage_key: string | null;
  readonly opportunity_id: string | null;
  readonly opportunity_status: 'open' | 'won' | 'lost' | null;
  readonly control_mode: 'automated' | 'manual' | null;
  readonly opened_at: Date | null;
  readonly value_cents: number | null;
  readonly value_kind: 'estimated' | 'agreed' | null;
  readonly meeting_id: string | null;
  readonly meeting_state: MeetingState | null;
  readonly meeting_starts_at: Date | null;
  readonly evidence_kind: string | null;
  readonly evidence_from_stage_key: string | null;
  readonly close_reason: string | null;
  readonly evidence_id: string | null;
  readonly evidence_occurred_at: Date | null;
  readonly pinned: boolean;
};

/**
 * Whether this caller could change this firm's stage.
 *
 * The same two clauses as `decideFirmMutation`, minus the merged-record case, which
 * the query has already excluded. It is deliberately a *read* of the same rule rather
 * than a call to it: `decideFirmMutation` is the decision made under the row lock at
 * mutation time and must stay that way, and this is a presentation question asked of
 * a snapshot. When they disagree — a reassignment between the board load and the
 * click — the mutation wins, and the person is told the firm is not theirs.
 */
function mayChangeStage(context: RepositoryContext, assignedUserId: string | null): boolean {
  const actor = context.scope.actor;
  if (actor.kind === 'system') return true;
  if (actor.role === 'admin') return true;
  return assignedUserId === actor.userId;
}

/**
 * The Kanban (call-to-booking, 0028): Interested, Demo booked, Decision pending,
 * Onboarding and Live, and Lost unless `includeLost` is explicitly false.
 *
 * Lost is shown by default (review fold 1, finding 4): installed desktops send `{}`
 * and build their stage selector from these columns, so a board without Lost would
 * take the Lost action away from them. The new desktop (slice K) sends `false`.
 *
 * Each firm is placed by its **current** opportunity — the open one, or else the most
 * recently closed one — so a Live customer stays in the Live column and a Lost firm
 * appears only when the filter asks. Retired stages are not columns unless an open
 * opportunity still sits in one (after 0028's remap none does). A closed opportunity's
 * id is never in `opportunityIdByFirmId`: closed opportunities are not moved from here.
 */
export async function readPipelineBoardForActor(
  context: RepositoryContext,
  options: { readonly limit?: number; readonly includeLost?: boolean } = {},
): Promise<PipelineBoardDto> {
  const includeLost = options.includeLost !== false;
  const stages = await listPipelineStages(context);
  const { rows } = await context.db.query<BoardRow>(
    `SELECT f.*, s.key AS stage_key, o.id AS opportunity_id, o.status AS opportunity_status,
            o.control_mode, o.opened_at,
            v.monthly_cents AS value_cents, v.kind AS value_kind,
            m.id AS meeting_id, m.state AS meeting_state, m.starts_at AS meeting_starts_at,
            ev.evidence_kind, ev.evidence_id, ev.occurred_at AS evidence_occurred_at,
            ev.from_stage_key AS evidence_from_stage_key,
            CASE WHEN o.status = 'lost' THEN o.close_reason END AS close_reason,
            (p.opportunity_id IS NOT NULL) AS pinned
       FROM firms f
       LEFT JOIN LATERAL (
         SELECT * FROM opportunities x
          WHERE x.workspace_id = f.workspace_id AND x.firm_id = f.id
          ORDER BY (x.status = 'open') DESC, x.closed_at DESC NULLS LAST, x.id
          LIMIT 1
       ) o ON true
       LEFT JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id
       LEFT JOIN LATERAL (
         SELECT monthly_cents, kind FROM opportunity_values y
          WHERE y.workspace_id = o.workspace_id AND y.opportunity_id = o.id
          ORDER BY y.recorded_at DESC, y.id DESC LIMIT 1
       ) v ON true
       LEFT JOIN LATERAL (
         SELECT id, state, starts_at FROM meetings z
          WHERE z.workspace_id = f.workspace_id AND z.firm_id = f.id
          ORDER BY z.updated_at DESC, z.id DESC LIMIT 1
       ) m ON true
       LEFT JOIN LATERAL (
         SELECT e.evidence_kind, e.evidence_id, e.occurred_at, fs.key AS from_stage_key
           FROM opportunity_stage_evidence e
           JOIN opportunity_stage_events se ON se.workspace_id = e.workspace_id AND se.id = e.stage_event_id
           LEFT JOIN pipeline_stages fs ON fs.workspace_id = se.workspace_id AND fs.id = se.from_stage_id
          WHERE e.workspace_id = o.workspace_id AND e.opportunity_id = o.id
            AND NOT EXISTS (
              SELECT 1 FROM opportunity_stage_events later
               WHERE later.workspace_id = se.workspace_id AND later.opportunity_id = se.opportunity_id
                 AND (later.occurred_at, later.id) > (se.occurred_at, se.id))
          ORDER BY e.recorded_at DESC, e.id DESC LIMIT 1
       ) ev ON true
       LEFT JOIN opportunity_stage_pins p ON p.workspace_id = o.workspace_id AND p.opportunity_id = o.id
      WHERE f.workspace_id = $1 AND f.status = 'active'
      ORDER BY f.name, f.id
      LIMIT $2`,
    [context.scope.workspaceId, Math.trunc(options.limit ?? 500)],
  );

  const opportunityIdByFirmId: Record<string, string> = {};
  const cards: Record<string, PipelineBoardCard> = {};
  const placed: FirmIdentityDto[] = [];
  const unplacedFirms: FirmIdentityDto[] = [];

  for (const row of rows) {
    const shown =
      row.stage_key !== null &&
      (row.opportunity_status === 'open' ||
        row.opportunity_status === 'won' ||
        (row.opportunity_status === 'lost' && includeLost));
    const dto = firmIdentityDtoOf(row, {
      stageKey: shown ? row.stage_key : null,
      status: shown ? row.opportunity_status : null,
      controlMode: shown ? row.control_mode : null,
      openedAt: !shown || row.opened_at === null ? null : row.opened_at.toISOString(),
    });
    if (!shown) {
      unplacedFirms.push(dto);
      continue;
    }
    placed.push(dto);
    cards[row.id] = {
      value: row.value_cents === null || row.value_kind === null ? null : { monthlyCents: Number(row.value_cents), kind: row.value_kind },
      meeting:
        row.meeting_id === null || row.meeting_state === null || row.meeting_starts_at === null
          ? null
          : { meetingId: row.meeting_id, state: row.meeting_state, startsAt: row.meeting_starts_at.toISOString() },
      evidence:
        row.evidence_kind === null || row.evidence_id === null || row.evidence_occurred_at === null
          ? null
          : {
              kind: row.evidence_kind,
              evidenceId: row.evidence_id,
              occurredAt: row.evidence_occurred_at.toISOString(),
              fromStageKey: row.evidence_from_stage_key,
            },
      pinned: row.pinned,
      closeReason: row.close_reason,
    };
    if (row.opportunity_status === 'open' && row.opportunity_id !== null && mayChangeStage(context, row.assigned_user_id)) {
      opportunityIdByFirmId[row.id] = row.opportunity_id;
    }
  }

  const occupied = new Set(placed.map(firm => firm.stageKey));
  const columns = stages
    .filter(stage => (stage.terminal_kind === 'lost' ? includeLost : !stage.retired || occupied.has(stage.key)))
    .map(stage => columnOf(stage, placed));

  return { columns, opportunityIdByFirmId, unplacedFirms, cards, stages: stages.map(stage => columnOf(stage, []).stage) };
}
