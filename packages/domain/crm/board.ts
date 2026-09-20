import type { RepositoryContext } from '../db/workspaceScope.ts';
import { firmIdentityDtoOf, type FirmIdentityDto } from './dto.ts';
import { listPipelineStages } from './pipeline.ts';
import type { FirmRow, PipelineStageRow } from './types.ts';

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

export interface PipelineBoardDto {
  readonly columns: readonly PipelineBoardColumn[];
  /**
   * The open opportunity id per firm, for the firms this caller may change. Sparse by
   * design; a firm absent from it is a firm whose column offers no stage control.
   */
  readonly opportunityIdByFirmId: Readonly<Record<string, string>>;
  /** Firms with no open opportunity. They are in no column and a person opens them. */
  readonly unplacedFirms: readonly FirmIdentityDto[];
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

export async function readPipelineBoardForActor(
  context: RepositoryContext,
  options: { readonly limit?: number } = {},
): Promise<PipelineBoardDto> {
  const stages = await listPipelineStages(context);
  const { rows } = await context.db.query<BoardRow>(
    `SELECT f.*, s.key AS stage_key, o.id AS opportunity_id, o.status AS opportunity_status,
            o.control_mode, o.opened_at
       FROM firms f
       LEFT JOIN opportunities o ON o.workspace_id = f.workspace_id AND o.firm_id = f.id AND o.status = 'open'
       LEFT JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id
      WHERE f.workspace_id = $1 AND f.status = 'active'
      ORDER BY f.name, f.id
      LIMIT $2`,
    [context.scope.workspaceId, Math.trunc(options.limit ?? 500)],
  );

  const opportunityIdByFirmId: Record<string, string> = {};
  const placed: FirmIdentityDto[] = [];
  const unplacedFirms: FirmIdentityDto[] = [];

  for (const row of rows) {
    const dto = firmIdentityDtoOf(row, {
      stageKey: row.stage_key,
      status: row.opportunity_status,
      controlMode: row.control_mode,
      openedAt: row.opened_at === null ? null : row.opened_at.toISOString(),
    });
    if (row.stage_key === null) {
      unplacedFirms.push(dto);
      continue;
    }
    placed.push(dto);
    if (row.opportunity_id !== null && mayChangeStage(context, row.assigned_user_id)) {
      opportunityIdByFirmId[row.id] = row.opportunity_id;
    }
  }

  return {
    columns: stages.map(stage => columnOf(stage, placed)),
    opportunityIdByFirmId,
    unplacedFirms,
  };
}
