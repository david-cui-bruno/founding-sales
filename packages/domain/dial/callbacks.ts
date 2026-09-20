import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { isKnownTimeZone } from '../src/rules/localClock.ts';
import { acceptPolicy, refusePolicy, type PolicyResult } from '../policy/types.ts';

/**
 * Callbacks (specification 9.1, 8.2, Appendix A, Appendix D).
 *
 * "Callback requested — set manual and create a callback after salesperson
 * confirmation of the instant." The confirmation is the whole reason this is a
 * separate function rather than a column on the call log: section 12.4 forbids an
 * LLM or a prose parser from committing an extracted instant by itself, so a
 * callback exists only where a person said yes, and `confirmed_by_user_id` records
 * who.
 *
 * Appendix D wants four things stored, not one: "Requested local date/time, source
 * zone, resolved UTC instant, all stored". The UTC instant is what the Today list
 * sorts on; the other three are what lets the card say "Tuesday at 2pm" a month
 * later, after a zone change or across a DST boundary, without recomputing a
 * different answer.
 */

export interface CreateCallbackInput {
  readonly firmId: string;
  readonly contactId?: string | undefined;
  readonly opportunityId?: string | undefined;
  readonly callLogId?: string | undefined;
  readonly assignedUserId: string;
  readonly localDate: string;
  readonly localTime?: string | undefined;
  readonly sourceTimeZone: string;
  /** The instant the salesperson confirmed, resolved to UTC by the caller. */
  readonly dueAt: string;
}

export interface CallbackRow {
  readonly id: string;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly assignedUserId: string;
  readonly requestedLocalDate: string;
  readonly requestedLocalTime: string | null;
  readonly sourceTimeZone: string;
  readonly dueAt: string;
  readonly status: 'open' | 'completed' | 'cancelled';
}

interface CallbackDbRow {
  readonly id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly assigned_user_id: string;
  readonly requested_local_date: Date | string;
  readonly requested_local_time: string | null;
  readonly source_time_zone: string;
  readonly due_at: Date;
  readonly status: 'open' | 'completed' | 'cancelled';
  readonly [column: string]: unknown;
}

const CALLBACK_COLUMNS = `id, firm_id, contact_id, assigned_user_id, requested_local_date::text AS requested_local_date,
  requested_local_time::text AS requested_local_time, source_time_zone, due_at, status`;

function toCallback(row: CallbackDbRow): CallbackRow {
  return {
    id: row.id,
    firmId: row.firm_id,
    contactId: row.contact_id,
    assignedUserId: row.assigned_user_id,
    requestedLocalDate: String(row.requested_local_date),
    requestedLocalTime: row.requested_local_time,
    sourceTimeZone: row.source_time_zone,
    dueAt: row.due_at.toISOString(),
    status: row.status,
  };
}

export async function createCallback(
  context: RepositoryContext,
  input: CreateCallbackInput,
): Promise<PolicyResult<CallbackRow>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('invalid_input');
  if (!isKnownTimeZone(input.sourceTimeZone)) return refusePolicy('invalid_input');
  if (!Number.isFinite(Date.parse(input.dueAt))) return refusePolicy('invalid_input');

  const { rows } = await context.db.query<CallbackDbRow>(
    `INSERT INTO callbacks
       (workspace_id, firm_id, contact_id, opportunity_id, call_log_id, assigned_user_id,
        requested_local_date, requested_local_time, source_time_zone, due_at,
        confirmed_at, confirmed_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::time, $9, $10::timestamptz, now(), $11)
     RETURNING ${CALLBACK_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.contactId ?? null,
      input.opportunityId ?? null,
      input.callLogId ?? null,
      input.assignedUserId,
      input.localDate,
      input.localTime ?? null,
      input.sourceTimeZone,
      input.dueAt,
      actor.userId,
    ],
  );
  const row = rows[0];
  if (row === undefined) return refusePolicy('invalid_input');

  await recordCrmAuditEvent(context, {
    action: 'callback.created',
    subjectKind: 'callback',
    subjectId: row.id,
    detail: { firmId: input.firmId, dueAt: input.dueAt, sourceTimeZone: input.sourceTimeZone },
  });
  return acceptPolicy(toCallback(row));
}

export async function completeCallback(
  context: RepositoryContext,
  input: { readonly callbackId: string },
): Promise<PolicyResult<CallbackRow>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('invalid_input');
  const { rows } = await context.db.query<CallbackDbRow>(
    `UPDATE callbacks
        SET status = 'completed', completed_at = now(), completed_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2 AND status = 'open'
      RETURNING ${CALLBACK_COLUMNS}`,
    [context.scope.workspaceId, input.callbackId, actor.userId],
  );
  const row = rows[0];
  if (row === undefined) {
    const existing = await context.db.query('SELECT 1 FROM callbacks WHERE workspace_id = $1 AND id = $2', [
      context.scope.workspaceId,
      input.callbackId,
    ]);
    return refusePolicy(existing.rows.length === 0 ? 'callback_unknown' : 'callback_not_open');
  }
  await recordCrmAuditEvent(context, {
    action: 'callback.completed',
    subjectKind: 'callback',
    subjectId: row.id,
    detail: { firmId: row.firm_id },
  });
  return acceptPolicy(toCallback(row));
}

export async function listCallbacks(
  context: RepositoryContext,
  options: { readonly assignedUserId?: string; readonly openOnly?: boolean; readonly limit?: number } = {},
): Promise<readonly CallbackRow[]> {
  const { rows } = await context.db.query<CallbackDbRow>(
    `SELECT ${CALLBACK_COLUMNS} FROM callbacks
      WHERE workspace_id = $1
        AND ($2::uuid IS NULL OR assigned_user_id = $2::uuid)
        AND ($3::boolean IS NOT TRUE OR status = 'open')
      ORDER BY due_at, id
      LIMIT $4`,
    [
      context.scope.workspaceId,
      options.assignedUserId ?? null,
      options.openOnly ?? false,
      Math.trunc(options.limit ?? 200),
    ],
  );
  return rows.map(toCallback);
}
