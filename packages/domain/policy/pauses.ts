import type { BlockedActionKind, PauseChannel, PauseScopeKind } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isAdminScope } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { openHold, releaseHold } from './holds.ts';
import {
  ALL_BLOCKED_ACTION_KINDS,
  CHANNEL_BLOCKED_ACTION_KINDS,
  acceptPolicy,
  refusePolicy,
  type PolicyResult,
} from './types.ts';

/**
 * Administrative pauses (specification 10.1, 4.3, Appendix A).
 *
 * "Every pause creates an active hold and reason history. Configuration never
 * bypasses suppression." And from the decision table: "Administrative pause —
 * reversible scoped hold with history; never a suppression or terminal stop."
 *
 * So a pause is two rows committed together: the `active_holds` row that actually
 * blocks work, and the `administrative_pauses` row that is the history of who paused
 * what and why. Releasing clears exactly the hold this pause opened — section 4.3's
 * "clearing one hold never clears another" — and leaves the pause row in place with
 * its release recorded.
 *
 * A pause never writes a `suppression_events` row and never stops an enrollment
 * terminally. Those are different things with different rules, and the one way to
 * keep them different is for this file not to know how to do either.
 */

export interface OpenPauseInput {
  readonly scopeKind: PauseScopeKind;
  /** The owner, mailbox or opportunity paused. Absent for `workspace` and `all_automation`. */
  readonly scopeKey?: string | undefined;
  /** Required for, and only for, `scopeKind = 'channel'`. */
  readonly channel?: PauseChannel | undefined;
  readonly reasonNote?: string | undefined;
  readonly commandId?: string | undefined;
}

export interface PauseRow {
  readonly id: string;
  readonly scopeKind: PauseScopeKind;
  readonly scopeKey: string | null;
  readonly channel: PauseChannel | null;
  readonly holdId: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly releasedAt: string | null;
}

interface PauseDbRow {
  readonly id: string;
  readonly scope_kind: PauseScopeKind;
  readonly scope_key: string | null;
  readonly channel: PauseChannel | null;
  readonly hold_id: string;
  readonly created_by_user_id: string;
  readonly created_at: Date;
  readonly released_at: Date | null;
  readonly [column: string]: unknown;
}

const PAUSE_COLUMNS = 'id, scope_kind, scope_key, channel, hold_id, created_by_user_id, created_at, released_at';

function toPause(row: PauseDbRow): PauseRow {
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeKey: row.scope_key,
    channel: row.channel,
    holdId: row.hold_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    releasedAt: row.released_at === null ? null : row.released_at.toISOString(),
  };
}

/**
 * The hold scope a pause scope becomes.
 *
 * `all_automation` has no equivalent in `active_holds.scope_kind` and does not need
 * one: a pause over all automation is a workspace hold that blocks every action
 * kind, and the distinction between the two is the pause row's own business.
 */
function holdScopeOf(scopeKind: PauseScopeKind): 'workspace' | 'owner' | 'mailbox' | 'opportunity' | 'channel' {
  return scopeKind === 'all_automation' ? 'workspace' : scopeKind;
}

function blockedKindsOf(input: OpenPauseInput): readonly BlockedActionKind[] {
  if (input.channel !== undefined) return CHANNEL_BLOCKED_ACTION_KINDS[input.channel];
  return ALL_BLOCKED_ACTION_KINDS;
}

export async function openPause(context: RepositoryContext, input: OpenPauseInput): Promise<PolicyResult<PauseRow>> {
  if (!isAdminScope(context.scope)) return refusePolicy('admin_only');
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('admin_only');

  const keyless = input.scopeKind === 'workspace' || input.scopeKind === 'all_automation';
  if (keyless !== (input.scopeKey === undefined)) return refusePolicy('invalid_input');
  if ((input.scopeKind === 'channel') !== (input.channel !== undefined)) return refusePolicy('invalid_input');

  const holdScope = holdScopeOf(input.scopeKind);
  const holdId = await openHold(context, {
    scopeKind: holdScope,
    ...(keyless ? {} : { scopeKey: input.scopeKind === 'channel' ? (input.channel ?? '') : (input.scopeKey ?? '') }),
    reasonCode: 'scoped_pause',
    blockedActionKinds: blockedKindsOf(input),
    sourceEventKind: 'administrative_pause',
    ...(input.commandId === undefined ? {} : { sourceEventId: input.commandId }),
    ...(input.scopeKind === 'owner' ? { ownerUserId: input.scopeKey } : {}),
    recoveryAction: 'release_pause',
  });

  const { rows } = await context.db.query<PauseDbRow>(
    `INSERT INTO administrative_pauses
       (workspace_id, scope_kind, scope_key, channel, reason_code, reason_note, hold_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, 'scoped_pause', $5, $6, $7)
     RETURNING ${PAUSE_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.scopeKind,
      keyless ? null : (input.scopeKey ?? null),
      input.channel ?? null,
      input.reasonNote ?? null,
      holdId,
      actor.userId,
    ],
  );
  const row = rows[0];
  if (row === undefined) return refusePolicy('invalid_input');

  await recordCrmAuditEvent(context, {
    action: 'pause.opened',
    subjectKind: 'administrative_pause',
    subjectId: row.id,
    detail: { scopeKind: input.scopeKind, channel: input.channel ?? null, holdId },
  });
  return acceptPolicy(toPause(row));
}

/** Release a pause and, with it, exactly the hold it opened. */
export async function releasePause(
  context: RepositoryContext,
  input: { readonly pauseId: string },
): Promise<PolicyResult<PauseRow>> {
  if (!isAdminScope(context.scope)) return refusePolicy('admin_only');
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('admin_only');

  const { rows } = await context.db.query<PauseDbRow>(
    `UPDATE administrative_pauses
        SET released_at = now(), released_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2 AND released_at IS NULL
      RETURNING ${PAUSE_COLUMNS}`,
    [context.scope.workspaceId, input.pauseId, actor.userId],
  );
  const row = rows[0];
  if (row === undefined) {
    const existing = await context.db.query('SELECT 1 FROM administrative_pauses WHERE workspace_id = $1 AND id = $2', [
      context.scope.workspaceId,
      input.pauseId,
    ]);
    return refusePolicy(existing.rows.length === 0 ? 'pause_unknown' : 'pause_already_released');
  }

  await releaseHold(context, row.hold_id);
  await recordCrmAuditEvent(context, {
    action: 'pause.released',
    subjectKind: 'administrative_pause',
    subjectId: row.id,
    detail: { holdId: row.hold_id },
  });
  return acceptPolicy(toPause(row));
}

export async function listPauses(
  context: RepositoryContext,
  options: { readonly openOnly?: boolean } = {},
): Promise<readonly PauseRow[]> {
  const { rows } = await context.db.query<PauseDbRow>(
    `SELECT ${PAUSE_COLUMNS} FROM administrative_pauses
      WHERE workspace_id = $1 AND ($2::boolean IS NOT TRUE OR released_at IS NULL)
      ORDER BY created_at DESC`,
    [context.scope.workspaceId, options.openOnly ?? false],
  );
  return rows.map(toPause);
}
