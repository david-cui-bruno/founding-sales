import {
  knownBlockedActionKinds,
  type FirmStopsDto,
  type FirmTaskDto,
  type FirmTimeline,
  type FollowUpPermissionDto,
  type PreparedBriefDto,
  type SuppressionChannel,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { holdEnrollments, type HoldEnrollmentDto } from '../sequences/holdEnrollments.ts';
import { followUpPermissionDto, listFollowUpPermissions } from '../sequences/followUpPermissions.ts';
import type { FirmReadDto } from './dto.ts';
import { readFirmForActor } from './dto.ts';
import { readPreparedBrief } from './preparedBriefs.ts';
import { readFirmTasks, readFirmTimeline } from './firmActivity.ts';
import { listFirmOpportunities } from './pipeline.ts';
import { accept, refuse, type CrmResult } from './types.ts';

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
  /** The enrollment the hold concerns, when it concerns one (R2). */
  readonly enrollment: HoldEnrollmentDto | null;
}

export interface OpportunitySummaryDto {
  readonly id: string;
  readonly status: 'open' | 'won' | 'lost';
  readonly stageKey: string;
  readonly controlMode: 'automated' | 'manual';
  readonly controlModeReason: string | null;
  readonly controlModeOrigin: 'human_reply' | 'engaged_call' | 'direct_send' | 'salesperson_command' | 'direct_send_keep_automation' | null;
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
      readonly followUpPermissions: readonly FollowUpPermissionDto[];
      /** Only when the caller negotiated it (`include: ['stops']`, migration 0037). */
      readonly stops?: FirmStopsDto;
      /** Only when negotiated (`include: ['preparedBrief']`, lane PB): the brief, or null. */
      readonly preparedBrief?: PreparedBriefDto | null;
      /** Only when negotiated (`include: ['tasks']`, S4F). */
      readonly tasks?: readonly FirmTaskDto[];
      /** Only when negotiated (`include: ['timeline']`, S4F). */
      readonly timeline?: FirmTimeline;
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
  readonly control_mode_origin: string | null;
  readonly opened_at: Date;
  readonly closed_at: Date | null;
  readonly close_reason: string | null;
  readonly [column: string]: unknown;
}

async function readPage(
  context: RepositoryContext,
  input: {
    readonly firmId: string;
    /** The second version, whose routes carry their technical validation. */
    readonly routeValidation?: boolean | undefined;
    /** `include: ['stops']` (migration 0037): add the stop badges' facts. */
    readonly includeStops?: boolean | undefined;
    /** `include: ['preparedBrief']` (lane PB, migration 0038): add the prepared brief. */
    readonly includePreparedBrief?: boolean | undefined;
    /** `include: ['tasks']` (S4F): the firm's open work. */
    readonly includeTasks?: boolean | undefined;
    readonly includeMeetingTasks?: boolean | undefined;
    /** `include: ['timeline']` (S4F): one page of the activity timeline. */
    readonly includeTimeline?: boolean | undefined;
    /** The timeline cursor (`timelineBefore`): the page older than it. */
    readonly timelineBefore?: string | undefined;
  },
  selectedOpportunityId?: string,
  plural = false,
): Promise<CrmResult<FirmPageDto>> {
  const read = await readFirmForActor(context, { firmId: input.firmId, routeValidation: input.routeValidation }, plural);
  if (!read.ok) return read;
  if (read.value.visibility === 'any_active_member') {
    return accept({ visibility: 'any_active_member', read: read.value });
  }

  const workspace = context.scope.workspaceId;
  // Legacy reads may represent one open deal, or exactly one closed deal.
  // Read all candidates in one statement before selecting; plural reads name their exact id.
  const opportunity = await context.db.query<OpportunityRowShape>(
    `SELECT o.id::text AS id, o.status, s.key AS stage_key, o.control_mode, o.control_mode_reason,
            o.control_mode_origin, o.opened_at, o.closed_at, o.close_reason
       FROM opportunities o
       JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id
      WHERE o.workspace_id = $1 AND o.firm_id = $2 AND ($3::uuid IS NULL OR o.id=$3)
      ORDER BY o.opened_at,o.id`,
    [workspace, input.firmId, selectedOpportunityId ?? null],
  );

  const openRows = opportunity.rows.filter((row) => row.status === 'open');
  if (!plural && selectedOpportunityId === undefined && opportunity.rows.length > 1 && openRows.length !== 1)
    return refuse('opportunity_ambiguous');
  const selectedOpportunity =
    selectedOpportunityId === undefined
      ? openRows.length === 1
        ? openRows[0]
        : opportunity.rows.length === 1
          ? opportunity.rows[0]
          : undefined
      : opportunity.rows[0];

  const history = await context.db.query<StageEventRow>(
    `SELECT e.id::text AS id, e.occurred_at, e.actor_kind, e.reason,
            was.key AS from_stage_key, becomes.key AS to_stage_key
       FROM opportunity_stage_events e
       JOIN pipeline_stages becomes
            ON becomes.workspace_id = e.workspace_id AND becomes.id = e.to_stage_id
       LEFT JOIN pipeline_stages was
            ON was.workspace_id = e.workspace_id AND was.id = e.from_stage_id
      WHERE e.workspace_id = $1 AND e.firm_id = $2 AND e.opportunity_id=$3
      ORDER BY e.occurred_at, e.id`,
    [workspace, input.firmId, selectedOpportunity?.id ?? null],
  );

  const holds = await context.db.query<HoldRow>(
    `SELECT id::text AS id, reason_code, blocked_action_kinds, started_at, recovery_action
       FROM active_holds
      WHERE workspace_id = $1 AND scope_kind = 'firm' AND scope_key = $2 AND released_at IS NULL
      ORDER BY started_at, id`,
    [workspace, input.firmId],
  );

  const enrollmentsOfHolds = await holdEnrollments(
    context,
    holds.rows.map((hold) => hold.id),
  );
  const row = selectedOpportunity;
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
            controlModeOrigin: (row.control_mode_origin ?? null) as OpportunitySummaryDto['controlModeOrigin'],
            openedAt: row.opened_at.toISOString(),
            closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
            closeReason: row.close_reason,
          },
    stageHistory: history.rows.map((event) => ({
      id: event.id,
      occurredAt: event.occurred_at.toISOString(),
      fromStageKey: event.from_stage_key,
      toStageKey: event.to_stage_key,
      actorKind: event.actor_kind,
      reason: event.reason,
    })),
    holds: holds.rows.map((hold) => ({
      id: hold.id,
      reasonCode: hold.reason_code,
      blockedActionKinds: knownBlockedActionKinds(hold.blocked_action_kinds),
      startedAt: hold.started_at.toISOString(),
      recoveryAction: hold.recovery_action,
      enrollment: enrollmentsOfHolds.get(hold.id) ?? null,
    })),
    // Migration 0025. Read after the holds because it is the same kind of fact: what
    // the automation may and may not do about this firm, and on whose authority.
    followUpPermissions: (await listFollowUpPermissions(context, { firmId: input.firmId })).map(followUpPermissionDto),
    ...(input.includeStops === true ? { stops: await readFirmStops(context, input.firmId) } : {}),
    ...(input.includePreparedBrief === true ? { preparedBrief: await readPreparedBrief(context, input.firmId) } : {}),
    ...(input.includeTasks === true
      ? { tasks: [...(await readFirmTasks(context, input.firmId, input.includeMeetingTasks === true))] }
      : {}),
    ...(input.includeTimeline === true ? { timeline: await readFirmTimeline(context, input.firmId, input.timelineBefore) } : {}),
  });
}

/**
 * The stop badges' facts (migration 0037, DESIGN-S3X §2.5, David's P2): which channels the
 * firm's own stops carry, and for each contact holding a stopped handle whether e-mail and
 * calls are stopped.
 *
 * The rule is the readers' own. A contact's e-mail is stopped by an `email` or `all` stop on
 * any of their handles (the union `suppressionSource` reads for an e-mail step); their calls
 * by a `phone` or `all` stop on any of them (the dial keys: their numbers and, for `all`,
 * their addresses). Because the CHECK keeps a number from carrying `email` and an address
 * from carrying `phone`, the two unions agree with the send gate and the dial. A firm stop
 * is reported once, at the firm, and not repeated on every contact.
 */
export async function readFirmStops(context: RepositoryContext, firmId: string): Promise<FirmStopsDto> {
  const workspace = context.scope.workspaceId;
  const firm = await context.db.query<{ channel: SuppressionChannel }>(
    `SELECT DISTINCT channel FROM effective_suppressions
      WHERE workspace_id = $1 AND scope = 'firm' AND canonical_key = lower($2::text)
      ORDER BY channel`,
    [workspace, firmId],
  );
  const contacts = await context.db.query<{ contact_id: string; email: boolean; phone: boolean }>(
    `WITH handles AS (
       SELECT a.contact_id, a.address AS canonical_key FROM email_addresses a
        WHERE a.workspace_id = $1 AND a.firm_id = $2 AND a.contact_id IS NOT NULL
       UNION
       SELECT p.contact_id, p.e164 FROM phone_routes p
        WHERE p.workspace_id = $1 AND p.firm_id = $2 AND p.contact_id IS NOT NULL
     )
     SELECT h.contact_id::text AS contact_id,
            bool_or(e.channel IN ('email', 'all')) AS email,
            bool_or(e.channel IN ('phone', 'all')) AS phone
       FROM handles h
       JOIN effective_suppressions e
         ON e.workspace_id = $1 AND e.scope = 'handle' AND e.canonical_key = h.canonical_key
      GROUP BY h.contact_id
      ORDER BY h.contact_id`,
    [workspace, firmId],
  );
  return {
    firm: firm.rows.map((row) => row.channel),
    contacts: contacts.rows.map((row) => ({ contactId: row.contact_id, email: row.email, phone: row.phone })),
  };
}

type PageInput = Parameters<typeof readPage>[1];
type DetailedPage = Extract<FirmPageDto, { visibility: 'assigned_or_admin' }>;
export type PluralFirmPageDto =
  | (Omit<DetailedPage, 'opportunity' | 'stageHistory'> & {
      readonly version: 3;
      readonly opportunities: readonly {
        opportunity: OpportunitySummaryDto;
        displayName: string | null;
        stageControlMode: 'legacy_rules' | 'human';
        stageHistory: readonly StageEventDto[];
      }[];
    })
  | (Extract<FirmPageDto, { visibility: 'any_active_member' }> & { readonly version: 3 });
export async function readFirmPage(context: RepositoryContext, input: PageInput): Promise<CrmResult<FirmPageDto>> {
  return readPage(context, input);
}
export async function readPluralFirmPage(context: RepositoryContext, input: PageInput): Promise<CrmResult<PluralFirmPageDto>> {
  const base = await readPage(context, input, undefined, true);
  if (!base.ok) return base;
  if (base.value.visibility === 'any_active_member') return accept({ ...base.value, version: 3 });
  const entries: {
    opportunity: OpportunitySummaryDto;
    displayName: string | null;
    stageControlMode: 'legacy_rules' | 'human';
    stageHistory: readonly StageEventDto[];
  }[] = [];
  for (const opportunity of await listFirmOpportunities(context, input.firmId)) {
    const selected = await readPage(context, input, opportunity.id, true);
    if (!selected.ok) return selected;
    if (selected.value.visibility !== 'assigned_or_admin') return accept({ ...selected.value, version: 3 });
    if (selected.value.opportunity !== null)
      entries.push({
        opportunity: selected.value.opportunity,
        displayName: opportunity.display_name ?? null,
        stageControlMode: opportunity.stage_control_mode ?? 'legacy_rules',
        stageHistory: selected.value.stageHistory,
      });
  }
  const { opportunity: _opportunity, stageHistory: _history, ...page } = base.value;
  return accept({ ...page, version: 3, opportunities: entries });
}
