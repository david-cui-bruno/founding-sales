import type { BlockedActionKind, HoldReasonCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForStopFact } from './sendGate.ts';
import type { OpenHold } from './types.ts';

/**
 * Reading and writing `active_holds` (specification 4.3, 15).
 *
 * "Automation is eligible only when the opportunity is automated and no applicable
 * active hold exists. Clearing one hold never clears another."
 *
 * The second sentence is why `releaseHolds` takes a source event and a reason code
 * rather than a scope: the ten-minute correction releases the holds *its own*
 * suppression opened and nothing else, and a release that matched on scope would
 * quietly clear a mailbox hold that happened to cover the same firm.
 *
 * `listApplicableHolds` is the read every eligibility decision makes. It is a single
 * indexed statement rather than four, because "no applicable hold" has to be one
 * answer at one instant: asking scope by scope would let a hold open between two of
 * the questions and be missed by both.
 */

const HOLD_COLUMNS = `id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind,
  source_event_id, owner_user_id, started_at, recovery_action`;

interface HoldRow {
  readonly id: string;
  readonly scope_kind: string;
  readonly scope_key: string | null;
  readonly reason_code: HoldReasonCode;
  readonly blocked_action_kinds: string[];
  readonly source_event_kind: string;
  readonly source_event_id: string | null;
  readonly owner_user_id: string | null;
  readonly started_at: Date;
  readonly recovery_action: string | null;
  readonly [column: string]: unknown;
}

function toOpenHold(row: HoldRow): OpenHold {
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeKey: row.scope_key,
    reasonCode: row.reason_code,
    blockedActionKinds: row.blocked_action_kinds as BlockedActionKind[],
    sourceEventKind: row.source_event_kind,
    sourceEventId: row.source_event_id,
    ownerUserId: row.owner_user_id,
    startedAt: row.started_at.toISOString(),
    recoveryAction: row.recovery_action,
  };
}

export interface HoldSubject {
  readonly actionKind: BlockedActionKind;
  readonly firmId?: string | undefined;
  readonly opportunityId?: string | undefined;
  readonly ownerUserId?: string | undefined;
  readonly mailboxId?: string | undefined;
  readonly enrollmentId?: string | undefined;
  readonly channel?: string | undefined;
}

/**
 * Every open hold that blocks this action kind for this subject, oldest first.
 *
 * A `workspace`-scoped hold applies to everything, which is why it has no key at all
 * in migration 0001; every other scope matches on its own key and on nothing else.
 * A subject that names no firm is not matched by a firm hold rather than by all of
 * them: failing closed means refusing the work, not widening the question.
 */
export async function listApplicableHolds(
  context: RepositoryContext,
  subject: HoldSubject,
): Promise<readonly OpenHold[]> {
  const { rows } = await context.db.query<HoldRow>(
    `SELECT ${HOLD_COLUMNS}
       FROM active_holds
      WHERE workspace_id = $1
        AND released_at IS NULL
        AND $2 = ANY (blocked_action_kinds)
        AND (
          scope_kind = 'workspace'
          OR (scope_kind = 'firm' AND scope_key IS NOT DISTINCT FROM $3)
          OR (scope_kind = 'opportunity' AND scope_key IS NOT DISTINCT FROM $4)
          OR (scope_kind = 'owner' AND scope_key IS NOT DISTINCT FROM $5)
          OR (scope_kind = 'mailbox' AND scope_key IS NOT DISTINCT FROM $6)
          OR (scope_kind = 'enrollment' AND scope_key IS NOT DISTINCT FROM $7)
          OR (scope_kind = 'channel' AND scope_key IS NOT DISTINCT FROM $8)
        )
      ORDER BY started_at, id`,
    [
      context.scope.workspaceId,
      subject.actionKind,
      subject.firmId ?? null,
      subject.opportunityId ?? null,
      subject.ownerUserId ?? null,
      subject.mailboxId ?? null,
      subject.enrollmentId ?? null,
      subject.channel ?? null,
    ],
  );
  // `IS NOT DISTINCT FROM $3` with a null subject would match a hold whose key is
  // null, which only a workspace hold has — and that arm already matched it. Guard
  // anyway, so a future scope with a nullable key cannot widen this silently.
  return rows.filter(row => row.scope_kind === 'workspace' || row.scope_key !== null).map(toOpenHold);
}

/**
 * Every open hold of this workspace, by reason code (Appendix E steps 1 and 9).
 *
 * `listApplicableHolds` answers "may this action happen to this subject", which is
 * the question the send and dial paths ask. The restore protocol asks a different
 * one: "is a `restore_in_progress` hold in force at all", and afterwards "did
 * advancing the generation release *only* those". Neither can be answered by the
 * subject-shaped read — a workspace with a held mailbox and no subject to name would
 * report nothing — so the reason is the filter and the subject is absent.
 *
 * `reason` and `excludeReason` are both optional and both honoured, because the
 * drill asks for each in turn and the complement has to be the complement of the
 * same set. An empty filter is every open hold.
 */
export async function listHoldsByReason(
  context: RepositoryContext,
  filter: { readonly reason?: HoldReasonCode | undefined; readonly excludeReason?: HoldReasonCode | undefined } = {},
): Promise<readonly OpenHold[]> {
  const { rows } = await context.db.query<HoldRow>(
    `SELECT ${HOLD_COLUMNS}
       FROM active_holds
      WHERE workspace_id = $1
        AND released_at IS NULL
        AND ($2::text IS NULL OR reason_code = $2)
        AND ($3::text IS NULL OR reason_code <> $3)
      ORDER BY started_at, id`,
    [context.scope.workspaceId, filter.reason ?? null, filter.excludeReason ?? null],
  );
  return rows.map(toOpenHold);
}

export interface OpenHoldInput {
  readonly scopeKind: 'workspace' | 'owner' | 'mailbox' | 'firm' | 'opportunity' | 'enrollment' | 'channel';
  readonly scopeKey?: string | undefined;
  readonly reasonCode: HoldReasonCode;
  readonly blockedActionKinds: readonly BlockedActionKind[];
  readonly sourceEventKind: string;
  readonly sourceEventId?: string | undefined;
  readonly ownerUserId?: string | undefined;
  readonly recoveryAction?: string | undefined;
}

/**
 * Open one hold and return its id. The caller commits it with whatever caused it.
 *
 * Every hold is a stop fact, so it takes the send gate first (lane g77,
 * `sendGate.ts`): a dispatch claim in flight finishes before this hold can commit,
 * and a claim that starts after it waits for the commit and then reads it.
 */
export async function openHold(context: RepositoryContext, input: OpenHoldInput): Promise<string> {
  await lockSendGateForStopFact(context);
  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO active_holds
       (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds,
        source_event_kind, source_event_id, owner_user_id, recovery_action)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9)
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.scopeKind,
      input.scopeKind === 'workspace' ? null : (input.scopeKey ?? null),
      input.reasonCode,
      [...input.blockedActionKinds],
      input.sourceEventKind,
      input.sourceEventId ?? null,
      input.ownerUserId ?? null,
      input.recoveryAction ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('a hold insert returned no row');
  return id;
}

export interface ReleasedHold {
  readonly id: string;
  readonly startedAt: string;
  readonly releasedAt: string;
}

/**
 * Release the holds one source event opened, and only those.
 *
 * Returns what was released with both instants, because the caller needs the
 * interval: section 4.3 shifts unexecuted work by the union of the blocking
 * intervals, and the union cannot be computed from a row that has been forgotten.
 */
export async function releaseHoldsOfEvent(
  context: RepositoryContext,
  input: { readonly sourceEventId: string; readonly reasonCode: HoldReasonCode },
): Promise<readonly ReleasedHold[]> {
  const { rows } = await context.db.query<{ id: string; started_at: Date; released_at: Date }>(
    `UPDATE active_holds
        SET released_at = now()
      WHERE workspace_id = $1
        AND source_event_id = $2
        AND reason_code = $3
        AND released_at IS NULL
      RETURNING id, started_at, released_at`,
    [context.scope.workspaceId, input.sourceEventId, input.reasonCode],
  );
  return rows.map(row => ({
    id: row.id,
    startedAt: row.started_at.toISOString(),
    releasedAt: row.released_at.toISOString(),
  }));
}

/** Release one hold by id. Used by the pause release, which knows exactly which one. */
export async function releaseHold(context: RepositoryContext, holdId: string): Promise<ReleasedHold | null> {
  const { rows } = await context.db.query<{ id: string; started_at: Date; released_at: Date }>(
    `UPDATE active_holds
        SET released_at = now()
      WHERE workspace_id = $1 AND id = $2 AND released_at IS NULL
      RETURNING id, started_at, released_at`,
    [context.scope.workspaceId, holdId],
  );
  const row = rows[0];
  return row === null || row === undefined
    ? null
    : { id: row.id, startedAt: row.started_at.toISOString(), releasedAt: row.released_at.toISOString() };
}
