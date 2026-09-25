import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { FirmReadDto } from './dto.ts';
import { readFirmForActor } from './dto.ts';
import { accept, type CrmResult } from './types.ts';

/**
 * Everything the desktop Firm page shows, in one read (specification 7.2, 7.3, 8.1,
 * 15 and Appendix F).
 *
 * The page needs four things the single-firm read does not carry: the open
 * opportunity's control mode and why, the append-only stage history, the holds
 * currently blocking the firm, and the reason each one is there. Assembling them in
 * the client would mean four round trips and four chances to forget the read matrix,
 * so they are assembled here, behind the same decision `readFirmForActor` makes.
 *
 * **Both extras are detail-class.** Appendix F row 1 covers "firm identity, pipeline
 * stage/dates, sequence status", which is the current stage and when it opened — and
 * the narrow DTO already carries those. A stage *history* is different: a Lost event
 * carries the reason a person typed, which is a note, and a hold carries what the
 * firm is blocked from and why, which is the shape of somebody else's work. A
 * colleague gets neither, and the page shows them nothing rather than an empty list
 * pretending there is nothing to show.
 *
 * The audit event for an admin's wide read is written by `readFirmForActor`, once,
 * because the extras below are reached only when that read already granted detail.
 */

export interface StageEventDto {
  readonly id: string;
  readonly occurredAt: string;
  readonly fromStageKey: string | null;
  readonly toStageKey: string;
  readonly actorKind: 'user' | 'admin' | 'system' | 'worker';
  /** Section 8.1: "Lost changes require a reason". Null for every other change. */
  readonly reason: string | null;
}

export interface FirmHoldDto {
  readonly id: string;
  readonly reasonCode: string;
  readonly blockedActionKinds: readonly string[];
  readonly startedAt: string;
  /** Section 15: only an explicitly recoverable hold may offer a control. */
  readonly recoveryAction: string | null;
}

export interface OpportunitySummaryDto {
  readonly id: string;
  readonly status: 'open' | 'won' | 'lost';
  readonly stageKey: string;
  readonly controlMode: 'automated' | 'manual';
  readonly controlModeReason: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
}

export type FirmPageDto =
  | { readonly visibility: 'any_active_member'; readonly read: FirmReadDto }
  | {
      readonly visibility: 'assigned_or_admin';
      readonly read: FirmReadDto;
      readonly opportunity: OpportunitySummaryDto | null;
      readonly stageHistory: readonly StageEventDto[];
      readonly holds: readonly FirmHoldDto[];
    };

interface StageEventRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly from_stage_key: string | null;
  readonly to_stage_key: string;
  readonly actor_kind: 'user' | 'admin' | 'system' | 'worker';
  readonly reason: string | null;
  readonly [column: string]: unknown;
}

interface HoldRow {
  readonly id: string;
  readonly reason_code: string;
  readonly blocked_action_kinds: string[];
  readonly started_at: Date;
  readonly recovery_action: string | null;
  readonly [column: string]: unknown;
}

interface OpportunityRowShape {
  readonly id: string;
  readonly status: 'open' | 'won' | 'lost';
  readonly stage_key: string;
  readonly control_mode: 'automated' | 'manual';
  readonly control_mode_reason: string | null;
  readonly opened_at: Date;
  readonly closed_at: Date | null;
  readonly close_reason: string | null;
  readonly [column: string]: unknown;
}

export async function readFirmPage(
  context: RepositoryContext,
  input: {
    readonly firmId: string;
    /** Lane g90: the second version, whose routes carry their technical validation. */
    readonly routeValidation?: boolean | undefined;
  },
): Promise<CrmResult<FirmPageDto>> {
  const read = await readFirmForActor(context, { firmId: input.firmId, routeValidation: input.routeValidation });
  if (!read.ok) return read;
  if (read.value.visibility === 'any_active_member') {
    return accept({ visibility: 'any_active_member', read: read.value });
  }

  const workspace = context.scope.workspaceId;
  // The most recent opportunity, open or closed: a Firm page after a loss still has
  // to show what was lost and why, which is what `closeReason` is for.
  const opportunity = await context.db.query<OpportunityRowShape>(
    `SELECT o.id::text AS id, o.status, s.key AS stage_key, o.control_mode, o.control_mode_reason,
            o.opened_at, o.closed_at, o.close_reason
       FROM opportunities o
       JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id
      WHERE o.workspace_id = $1 AND o.firm_id = $2
      ORDER BY (o.status = 'open') DESC, o.opened_at DESC
      LIMIT 1`,
    [workspace, input.firmId],
  );

  const history = await context.db.query<StageEventRow>(
    `SELECT e.id::text AS id, e.occurred_at, e.actor_kind, e.reason,
            was.key AS from_stage_key, becomes.key AS to_stage_key
       FROM opportunity_stage_events e
       JOIN pipeline_stages becomes
            ON becomes.workspace_id = e.workspace_id AND becomes.id = e.to_stage_id
       LEFT JOIN pipeline_stages was
            ON was.workspace_id = e.workspace_id AND was.id = e.from_stage_id
      WHERE e.workspace_id = $1 AND e.firm_id = $2
      ORDER BY e.occurred_at, e.id`,
    [workspace, input.firmId],
  );

  const holds = await context.db.query<HoldRow>(
    `SELECT id::text AS id, reason_code, blocked_action_kinds, started_at, recovery_action
       FROM active_holds
      WHERE workspace_id = $1 AND scope_kind = 'firm' AND scope_key = $2 AND released_at IS NULL
      ORDER BY started_at, id`,
    [workspace, input.firmId],
  );

  const row = opportunity.rows[0];
  return accept({
    visibility: 'assigned_or_admin',
    read: read.value,
    opportunity:
      row === undefined
        ? null
        : {
            id: row.id,
            status: row.status,
            stageKey: row.stage_key,
            controlMode: row.control_mode,
            controlModeReason: row.control_mode_reason,
            openedAt: row.opened_at.toISOString(),
            closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
            closeReason: row.close_reason,
          },
    stageHistory: history.rows.map(event => ({
      id: event.id,
      occurredAt: event.occurred_at.toISOString(),
      fromStageKey: event.from_stage_key,
      toStageKey: event.to_stage_key,
      actorKind: event.actor_kind,
      reason: event.reason,
    })),
    holds: holds.rows.map(hold => ({
      id: hold.id,
      reasonCode: hold.reason_code,
      blockedActionKinds: [...hold.blocked_action_kinds],
      startedAt: hold.started_at.toISOString(),
      recoveryAction: hold.recovery_action,
    })),
  });
}
