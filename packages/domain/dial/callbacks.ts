import { callbackInstant } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { isKnownTimeZone } from '../src/rules/localClock.ts';
import { completeTodayItemsByKey } from '../today/snapshots.ts';
import { callbackTimeNeededItemKey } from '../today/types.ts';
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
 *
 * ## The instant is the server's resolution (audit item C18)
 *
 * The local date, time and zone are resolved here through `callbackInstant` — the one calendar clock, shared with the
 * Mac through `@fss/contracts` — and a supplied `dueAt` must equal that resolution or
 * the callback is refused as `callback_instant_mismatch`. The client's `dueAt` is
 * what it showed the person; refusing a disagreement is what makes "the instant the
 * salesperson confirmed" and "the instant stored" the same instant.
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
  /** What the client resolved and showed, if it sent one. Checked, never trusted. */
  readonly dueAt?: string | undefined;
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

export type ConfirmedInstant =
  | { readonly ok: true; readonly dueAt: string }
  | { readonly ok: false; readonly reason: 'invalid_input' | 'callback_instant_mismatch' };

/**
 * The instant a callback's local fields name, and whether the client's `dueAt` agrees.
 *
 * Pure, and exported so `logCallOutcome` can decide before it writes anything whether a
 * callback can be committed at all (C14: a refusal must never follow a write).
 * Millisecond equality rather than string equality: `2026-03-08T07:30:00Z` and
 * `2026-03-08T07:30:00.000Z` are one instant.
 */
export function resolveConfirmedInstant(input: {
  readonly localDate: string;
  readonly localTime?: string | undefined;
  readonly sourceTimeZone: string;
  readonly dueAt?: string | undefined;
}): ConfirmedInstant {
  if (!isKnownTimeZone(input.sourceTimeZone)) return { ok: false, reason: 'invalid_input' };
  const resolved = callbackInstant(input.localDate, input.localTime, input.sourceTimeZone);
  if (resolved === null) return { ok: false, reason: 'invalid_input' };
  if (input.dueAt !== undefined) {
    const supplied = Date.parse(input.dueAt);
    if (!Number.isFinite(supplied)) return { ok: false, reason: 'invalid_input' };
    if (supplied !== Date.parse(resolved)) return { ok: false, reason: 'callback_instant_mismatch' };
  }
  return { ok: true, dueAt: resolved };
}

export async function createCallback(
  context: RepositoryContext,
  input: CreateCallbackInput,
): Promise<PolicyResult<CallbackRow>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('invalid_input');
  const instant = resolveConfirmedInstant(input);
  if (!instant.ok) return refusePolicy(instant.reason);
  const localTime = input.localTime === undefined || input.localTime.trim() === '' ? null : input.localTime.trim();

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
      localTime,
      input.sourceTimeZone,
      instant.dueAt,
      actor.userId,
    ],
  );
  const row = rows[0];
  if (row === undefined) return refusePolicy('invalid_input');

  await recordCrmAuditEvent(context, {
    action: 'callback.created',
    subjectKind: 'callback',
    subjectId: row.id,
    detail: { firmId: input.firmId, dueAt: instant.dueAt, sourceTimeZone: input.sourceTimeZone },
  });
  return acceptPolicy(toCallback(row));
}

/**
 * Complete a callback (Appendix A "Callback confirm/complete").
 *
 * The Today task is finished by `callbacks_today_promotion`, in this statement's
 * transaction. The firm is locked and the CRM's assignment rule is applied first: completing a colleague's callback is a mutation of their firm
 * (Appendix G 7), and `logCallOutcome` now completes callbacks too.
 */
export async function completeCallback(
  context: RepositoryContext,
  input: { readonly callbackId: string },
): Promise<PolicyResult<CallbackRow>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('invalid_input');
  const existing = await context.db.query<{ firm_id: string; status: string }>(
    'SELECT firm_id, status FROM callbacks WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, input.callbackId],
  );
  const found = existing.rows[0];
  if (found === undefined) return refusePolicy('callback_unknown');
  const firm = await loadFirmForUpdate(context, found.firm_id);
  if (firm === null) return refusePolicy('callback_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) {
    return refusePolicy(permitted.reason === 'not_assigned' ? 'not_assigned' : 'callback_unknown');
  }

  const { rows } = await context.db.query<CallbackDbRow>(
    `UPDATE callbacks
        SET status = 'completed', completed_at = now(), completed_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2 AND status = 'open'
      RETURNING ${CALLBACK_COLUMNS}`,
    [context.scope.workspaceId, input.callbackId, actor.userId],
  );
  const row = rows[0];
  if (row === undefined) return refusePolicy('callback_not_open');
  await recordCrmAuditEvent(context, {
    action: 'callback.completed',
    subjectKind: 'callback',
    subjectId: row.id,
    detail: { firmId: row.firm_id },
  });
  return acceptPolicy(toCallback(row));
}

export interface ScheduleCallbackForCallInput {
  readonly callLogId: string;
  readonly localDate: string;
  readonly localTime?: string | undefined;
  readonly sourceTimeZone: string;
  readonly dueAt?: string | undefined;
}

/**
 * Give a recorded "call me back" its confirmed instant, later (audit C13).
 *
 * `logCallOutcome` records a callback request that arrived without an instant — or
 * with one the server resolved differently — and puts "Callback — needs a time" on
 * Today. This is the other half: the salesperson says when, and the callback is
 * created beside the call that asked for it, exactly as the outcome would have
 * created it, with the needs-a-time task finished in the same transaction.
 *
 * Every refusal is decided before the insert.
 */
export async function scheduleCallbackForCall(
  context: RepositoryContext,
  input: ScheduleCallbackForCallInput,
): Promise<PolicyResult<CallbackRow>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refusePolicy('invalid_input');

  const { rows: logs } = await context.db.query<{
    firm_id: string;
    contact_id: string | null;
    opportunity_id: string | null;
    outcome: string;
  }>(
    'SELECT firm_id, contact_id, opportunity_id, outcome FROM call_logs WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, input.callLogId],
  );
  const log = logs[0];
  if (log === undefined || log.outcome !== 'callback_requested') return refusePolicy('call_log_unknown');

  const firm = await loadFirmForUpdate(context, log.firm_id);
  if (firm === null) return refusePolicy('call_log_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) {
    return refusePolicy(permitted.reason === 'not_assigned' ? 'not_assigned' : 'call_log_unknown');
  }

  const already = await context.db.query(
    'SELECT 1 FROM callbacks WHERE workspace_id = $1 AND call_log_id = $2',
    [context.scope.workspaceId, input.callLogId],
  );
  if (already.rows.length > 0) return refusePolicy('callback_already_scheduled');

  const instant = resolveConfirmedInstant(input);
  if (!instant.ok) return refusePolicy(instant.reason);

  const created = await createCallback(context, {
    firmId: log.firm_id,
    ...(log.contact_id === null ? {} : { contactId: log.contact_id }),
    ...(log.opportunity_id === null ? {} : { opportunityId: log.opportunity_id }),
    callLogId: input.callLogId,
    assignedUserId: firm.assigned_user_id ?? actor.userId,
    localDate: input.localDate,
    ...(input.localTime === undefined ? {} : { localTime: input.localTime }),
    sourceTimeZone: input.sourceTimeZone,
    dueAt: instant.dueAt,
  });
  if (!created.ok) return created;
  await completeTodayItemsByKey(context, { firmId: log.firm_id, itemKey: callbackTimeNeededItemKey(input.callLogId) });
  return created;
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
