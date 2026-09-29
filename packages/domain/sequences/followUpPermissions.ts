import {
  FOLLOW_UP_PERMISSION_WINDOW_DAYS,
  type FollowUpGrantRule,
  type FollowUpPermissionDto,
  type FollowUpPermissionKind,
  type FollowUpPermissionScope,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { resolveStepDue } from '../src/rules/cadence.ts';
import type { WorkspaceHolidayCalendar } from '../src/rules/businessDays.ts';
import { readSequenceVersion } from './rows.ts';
import { refuseSequence, acceptSequence, type SequenceResult, type SequenceStepRow } from './types.ts';

/**
 * Follow-up permissions: the evidence a send rests on (migration 0025).
 *
 * David, 29 September 2026: *"Record the enrollment origin alongside the supporting
 * event, recipient, permitted follow-up, and timing. **The origin label alone must not
 * authorize sending.**"*
 *
 * That last sentence is this file's whole design. A permission row is a label too, so
 * nothing here trusts one: `verifyFollowUpPermission` re-reads the **evidence row it
 * points at** — the call log, or the inbound message's match to the firm — and refuses
 * when that row has gone, names another firm, or names another person. The row carries
 * the decision; the evidence carries the authority.
 *
 * Read with `packages/domain/sequences/eligibility.ts` (`followUpPermissionSource`,
 * which is where every refusal below becomes a hold on a card) and
 * `docs/greenfield/decisions/follow-up-eligibility-20260929.md`.
 */

/** A permission as stored. Dates are ISO instants, as every row shape in this lane is. */
export interface FollowUpPermissionRow {
  readonly id: string;
  readonly firmId: string;
  readonly contactId: string;
  readonly kind: FollowUpPermissionKind;
  readonly scope: FollowUpPermissionScope;
  readonly callLogId: string | null;
  readonly mailMessageId: string | null;
  readonly bookingReference: string | null;
  readonly sequenceId: string | null;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly grantedByUserId: string | null;
  readonly grantedByRule: string | null;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly note: string | null;
}

const PERMISSION_COLUMNS = `id, firm_id, contact_id, kind, scope, call_log_id, mail_message_id,
  booking_reference, sequence_id, granted_at, expires_at, granted_by_user_id, granted_by_rule,
  consumed_at, revoked_at, note`;

interface PermissionDbRow {
  readonly id: string;
  readonly firm_id: string;
  readonly contact_id: string;
  readonly kind: FollowUpPermissionKind;
  readonly scope: FollowUpPermissionScope;
  readonly call_log_id: string | null;
  readonly mail_message_id: string | null;
  readonly booking_reference: string | null;
  readonly sequence_id: string | null;
  readonly granted_at: Date;
  readonly expires_at: Date;
  readonly granted_by_user_id: string | null;
  readonly granted_by_rule: string | null;
  readonly consumed_at: Date | null;
  readonly revoked_at: Date | null;
  readonly note: string | null;
  readonly [column: string]: unknown;
}

function toPermission(row: PermissionDbRow): FollowUpPermissionRow {
  return {
    id: row.id,
    firmId: row.firm_id,
    contactId: row.contact_id,
    kind: row.kind,
    scope: row.scope,
    callLogId: row.call_log_id,
    mailMessageId: row.mail_message_id,
    bookingReference: row.booking_reference,
    sequenceId: row.sequence_id,
    grantedAt: row.granted_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    grantedByUserId: row.granted_by_user_id,
    grantedByRule: row.granted_by_rule,
    consumedAt: row.consumed_at === null ? null : row.consumed_at.toISOString(),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    note: row.note,
  };
}

/** The wire shape, for the firm page. Every field, because every field is the evidence trail. */
export function followUpPermissionDto(row: FollowUpPermissionRow): FollowUpPermissionDto {
  return { ...row };
}

export async function readFollowUpPermission(
  context: RepositoryContext,
  permissionId: string,
): Promise<FollowUpPermissionRow | null> {
  const { rows } = await context.db.query<PermissionDbRow>(
    `SELECT ${PERMISSION_COLUMNS} FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, permissionId],
  );
  const row = rows[0];
  return row === undefined ? null : toPermission(row);
}

/** A firm's permissions, newest grant first — the firm page's list. */
export async function listFollowUpPermissions(
  context: RepositoryContext,
  input: { readonly firmId?: string | undefined; readonly contactId?: string | undefined } = {},
): Promise<readonly FollowUpPermissionRow[]> {
  const { rows } = await context.db.query<PermissionDbRow>(
    `SELECT ${PERMISSION_COLUMNS} FROM follow_up_permissions
      WHERE workspace_id = $1
        AND ($2::uuid IS NULL OR firm_id = $2)
        AND ($3::uuid IS NULL OR contact_id = $3)
      ORDER BY granted_at DESC, id`,
    [context.scope.workspaceId, input.firmId ?? null, input.contactId ?? null],
  );
  return rows.map(toPermission);
}

// ---------------------------------------------------------------------------
// The verification
// ---------------------------------------------------------------------------

/** Why a permission does not authorize this step. One of migration 0025's four codes. */
export type FollowUpRefusal =
  | 'follow_up_not_permitted'
  | 'follow_up_expired'
  | 'follow_up_scope_exhausted';

export type FollowUpVerdict =
  | { readonly ok: true; readonly permission: FollowUpPermissionRow }
  | { readonly ok: false; readonly refusal: FollowUpRefusal; readonly detail: string };

/** What the step being checked is, as far as a permission's scope is concerned. */
export interface FollowUpSubject {
  readonly firmId: string;
  /** The recipient the step would write to. */
  readonly contactId: string;
  /** Database time. Nothing here reads a host clock. */
  readonly now: string;
  /**
   * The sequence the step belongs to, when there is one. `agreed_sequence` is permitted
   * for its own sequence and no other, so a step of a different sequence is refused
   * even though the permission is live.
   */
  readonly sequenceId?: string | null | undefined;
  /**
   * How many steps the enrollment has. `contextual_reply` permits *a* reply: an
   * enrollment of more than one step is not one.
   */
  readonly stepCount?: number | undefined;
}

/**
 * Whether this permission authorizes writing to this person, now.
 *
 * Six questions, in the order a refusal is most worth reading:
 *
 *   1. the row exists, and belongs to this workspace (the scope does that);
 *   2. it names **this** firm and **this** recipient;
 *   3. it has not been revoked;
 *   4. its evidence row still exists and still names the same firm and recipient —
 *      the question that makes this a verification rather than a label read;
 *   5. it has not expired;
 *   6. its scope still has room: `single_email` once, `agreed_sequence` for its own
 *      sequence, `contextual_reply` for a single reply step, and
 *      `booking_communications` **never** — reserved until a booking table exists.
 *
 * `expires_at` is compared against database time passed in, never `Date.now()`.
 */
export async function verifyFollowUpPermission(
  context: RepositoryContext,
  permissionId: string,
  subject: FollowUpSubject,
): Promise<FollowUpVerdict> {
  const permission = await readFollowUpPermission(context, permissionId);
  if (permission === null) {
    return { ok: false, refusal: 'follow_up_not_permitted', detail: 'permission_missing' };
  }
  if (permission.firmId !== subject.firmId) {
    return { ok: false, refusal: 'follow_up_not_permitted', detail: 'firm_mismatch' };
  }
  if (permission.contactId !== subject.contactId) {
    return { ok: false, refusal: 'follow_up_not_permitted', detail: 'recipient_mismatch' };
  }
  if (permission.revokedAt !== null) {
    return { ok: false, refusal: 'follow_up_not_permitted', detail: 'revoked' };
  }

  const evidence = await verifyEvidence(context, permission);
  if (evidence !== null) return { ok: false, refusal: 'follow_up_not_permitted', detail: evidence };

  if (Date.parse(permission.expiresAt) <= Date.parse(subject.now)) {
    return { ok: false, refusal: 'follow_up_expired', detail: permission.expiresAt };
  }

  switch (permission.scope) {
    case 'single_email':
      if (permission.consumedAt !== null) {
        return { ok: false, refusal: 'follow_up_scope_exhausted', detail: 'already_sent' };
      }
      if (subject.stepCount !== undefined && subject.stepCount > 1) {
        return { ok: false, refusal: 'follow_up_scope_exhausted', detail: `steps:${String(subject.stepCount)}` };
      }
      break;
    case 'contextual_reply':
      if (subject.stepCount !== undefined && subject.stepCount > 1) {
        return { ok: false, refusal: 'follow_up_scope_exhausted', detail: `steps:${String(subject.stepCount)}` };
      }
      break;
    case 'agreed_sequence':
      if (
        subject.sequenceId !== undefined &&
        subject.sequenceId !== null &&
        permission.sequenceId !== subject.sequenceId
      ) {
        return { ok: false, refusal: 'follow_up_scope_exhausted', detail: 'another_sequence' };
      }
      break;
    case 'booking_communications':
      // Reserved, and said out loud rather than waved through. David named the origin
      // ("a booking permits relevant booking communications") before Cal.com exists, so
      // there is no booking table, and `booking_reference` is a text nothing can check.
      // A scope whose evidence cannot be re-read cannot satisfy the rule this file is
      // for, so it refuses until the table arrives.
      return { ok: false, refusal: 'follow_up_not_permitted', detail: 'booking_scope_reserved' };
  }

  return { ok: true, permission };
}

/**
 * The evidence row, re-read. `null` when it is sound; otherwise the detail of the
 * refusal.
 *
 * A call log: the same firm, and — when the log records one — the same person. A call
 * log with no `contact_id` is a call to the firm's main line, which is evidence about
 * the firm; the permission's own composite foreign key already holds its contact at
 * that firm.
 *
 * An inbound e-mail: `mail_messages` carries no firm, so the evidence is the *match*
 * (`mail_message_matches`), which is the row 12.3 writes and a person resolves. That
 * row can be deleted or re-pointed by a merge, and if it is, the message is no longer
 * evidence about this firm — which is exactly the case this check exists for. The
 * direction is `incoming` (migration 0009's vocabulary; the verification document of
 * 29 September says "inbound", which is the same thing in English and not in SQL).
 */
async function verifyEvidence(
  context: RepositoryContext,
  permission: FollowUpPermissionRow,
): Promise<string | null> {
  if (permission.callLogId !== null) {
    const { rows } = await context.db.query<{ firm_id: string; contact_id: string | null }>(
      'SELECT firm_id, contact_id FROM call_logs WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, permission.callLogId],
    );
    const log = rows[0];
    if (log === undefined) return 'call_log_missing';
    if (log.firm_id !== permission.firmId) return 'call_log_firm_mismatch';
    if (log.contact_id !== null && log.contact_id !== permission.contactId) return 'call_log_contact_mismatch';
    return null;
  }
  if (permission.mailMessageId !== null) {
    const { rows } = await context.db.query<{ matched: boolean }>(
      `SELECT true AS matched
         FROM mail_message_matches m
         JOIN mail_messages mm ON mm.workspace_id = m.workspace_id AND mm.id = m.mail_message_id
        WHERE m.workspace_id = $1
          AND m.mail_message_id = $2
          AND m.firm_id = $3
          AND (m.contact_id IS NULL OR m.contact_id = $4)
          AND mm.direction = 'incoming'
        LIMIT 1`,
      [context.scope.workspaceId, permission.mailMessageId, permission.firmId, permission.contactId],
    );
    return rows[0] === undefined ? 'inbound_match_missing' : null;
  }
  // `follow_up_permissions_has_evidence` leaves only the booking reference, and the
  // scope arm above refuses it before anything can rest on it.
  return 'booking_scope_reserved';
}

// ---------------------------------------------------------------------------
// Granting
// ---------------------------------------------------------------------------

export interface GrantFollowUpPermissionInput {
  readonly firmId: string;
  readonly contactId: string;
  readonly kind: FollowUpPermissionKind;
  readonly scope: FollowUpPermissionScope;
  readonly callLogId?: string | undefined;
  readonly mailMessageId?: string | undefined;
  readonly bookingReference?: string | undefined;
  readonly sequenceId?: string | undefined;
  readonly note?: string | undefined;
  /** A person, or one of `FOLLOW_UP_GRANT_RULES` when the flow itself is the granter. */
  readonly grantedByUserId?: string | undefined;
  readonly grantedByRule?: FollowUpGrantRule | undefined;
  /** Overrides the scope's default window. The only caller that needs it is a test. */
  readonly expiresAt?: string | undefined;
}

/**
 * Grant one permission.
 *
 * It refuses rather than stores when the evidence does not hold up, so the
 * verification is asked at both ends: a permission that could never authorize anything
 * is not a record worth keeping, it is a misleading one.
 */
export async function grantFollowUpPermission(
  context: RepositoryContext,
  input: GrantFollowUpPermissionInput,
): Promise<SequenceResult<FollowUpPermissionRow>> {
  if ((input.grantedByUserId === undefined) === (input.grantedByRule === undefined)) {
    return refuseSequence('invalid_input');
  }
  if (input.scope === 'agreed_sequence' ? input.sequenceId === undefined : input.sequenceId !== undefined) {
    return refuseSequence('invalid_input');
  }
  if (input.scope === 'booking_communications' && input.bookingReference === undefined) {
    return refuseSequence('invalid_input');
  }
  if (
    input.callLogId === undefined &&
    input.mailMessageId === undefined &&
    input.bookingReference === undefined
  ) {
    return refuseSequence('invalid_input');
  }

  const { rows: clock } = await context.db.query<{ now: Date }>('SELECT now() AS now');
  const grantedAt = (clock[0]?.now ?? new Date()).toISOString();
  const expiry = input.expiresAt ?? (await defaultExpiry(context, input, grantedAt));
  if (expiry === null) return refuseSequence('sequence_unknown');

  const { rows } = await context.db.query<PermissionDbRow>(
    `INSERT INTO follow_up_permissions
       (workspace_id, firm_id, contact_id, kind, scope, call_log_id, mail_message_id, booking_reference,
        sequence_id, granted_at, expires_at, granted_by_user_id, granted_by_rule, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12, $13, $14)
     RETURNING ${PERMISSION_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.contactId,
      input.kind,
      input.scope,
      input.callLogId ?? null,
      input.mailMessageId ?? null,
      input.bookingReference ?? null,
      input.sequenceId ?? null,
      grantedAt,
      expiry,
      input.grantedByUserId ?? null,
      input.grantedByRule ?? null,
      input.note ?? null,
    ],
  );
  const created = rows[0];
  if (created === undefined) return refuseSequence('invalid_input');
  const permission = toPermission(created);

  // Asked of the stored row, with its own evidence: the grant refuses what the step
  // would have refused later, at the moment a person can still do something about it.
  const verdict = await verifyFollowUpPermission(context, permission.id, {
    firmId: permission.firmId,
    contactId: permission.contactId,
    now: grantedAt,
    ...(permission.sequenceId === null ? {} : { sequenceId: permission.sequenceId }),
  });
  if (!verdict.ok && verdict.refusal === 'follow_up_not_permitted' && verdict.detail !== 'booking_scope_reserved') {
    // Not stored: the statement is rolled back by the caller's command transaction, and
    // the refusal names the evidence rather than the row.
    throw new FollowUpEvidenceError(verdict.detail);
  }
  return acceptSequence(permission);
}

/** The evidence a grant named does not support it. Thrown so the command's transaction rolls back. */
export class FollowUpEvidenceError extends Error {
  constructor(public readonly detail: string) {
    super(`the follow-up permission's evidence does not support it: ${detail}`);
    this.name = 'FollowUpEvidenceError';
  }
}

/**
 * The scope's own window (`FOLLOW_UP_PERMISSION_WINDOW_DAYS`), or — for
 * `agreed_sequence` — the instant the agreed sequence's last step would have been due.
 *
 * "An agreed follow-up sequence can run within its agreed scope" is a length as well as
 * a name: the permission ends when the sequence would have. The chain is the cadence
 * rule itself (`resolveStepDue`, step by step from the grant), so the permission and
 * the plan cannot disagree about how long the plan is.
 */
async function defaultExpiry(
  context: RepositoryContext,
  input: GrantFollowUpPermissionInput,
  grantedAt: string,
): Promise<string | null> {
  const days = FOLLOW_UP_PERMISSION_WINDOW_DAYS[input.scope];
  if (days !== null) {
    return new Date(Date.parse(grantedAt) + days * 24 * 60 * 60 * 1000).toISOString();
  }
  const sequenceId = input.sequenceId;
  if (sequenceId === undefined) return null;
  const { rows } = await context.db.query<{ id: string; time_zone: string | null }>(
    `SELECT v.id, f.time_zone
       FROM sequence_versions v
       LEFT JOIN firms f ON f.workspace_id = v.workspace_id AND f.id = $3
      WHERE v.workspace_id = $1 AND v.sequence_id = $2 AND v.state = 'published'
      ORDER BY v.version DESC
      LIMIT 1`,
    [context.scope.workspaceId, sequenceId, input.firmId],
  );
  const chosen = rows[0];
  if (chosen === undefined) return null;
  const version = await readSequenceVersion(context, chosen.id);
  if (version === null || version.steps.length === 0) return null;
  return agreedSequenceExpiry(version.steps, grantedAt, chosen.time_zone ?? 'America/New_York');
}

/**
 * When the last step of `steps` would be due if the sequence started at `from`.
 *
 * The calendar is deliberately omitted: a holiday shifts a due instant by a day, and a
 * permission's end is a bound rather than a schedule. Erring a day short of the plan
 * would refuse the plan's own last step, so the chain runs without holidays and the
 * bound is the earliest honest one that still covers every step.
 */
export function agreedSequenceExpiry(
  steps: readonly SequenceStepRow[],
  from: string,
  zone: string,
  calendar?: WorkspaceHolidayCalendar | undefined,
): string {
  let instant = from;
  for (const step of [...steps].sort((left, right) => left.ordinal - right.ordinal)) {
    // The cadence shape, inline rather than through `stepForCadence`: `enrollments.ts`
    // imports this module, and a cycle between the two would be a cycle the bundler has
    // to break rather than a dependency somebody chose.
    instant = resolveStepDue(
      {
        id: step.id,
        ordinal: step.ordinal,
        channel: step.channel,
        delay: step.delay,
        ...(step.onNoAnswer === null ? {} : { onNoAnswer: step.onNoAnswer }),
      },
      instant,
      zone,
      calendar,
    ).dueAt;
  }
  // One day past the last step's due instant, so the step due on the final day is
  // inside the window rather than exactly on its edge (`expires_at > granted_at`, and
  // the source compares with `<=`).
  return new Date(Date.parse(instant) + 24 * 60 * 60 * 1000).toISOString();
}

/** Revoke a permission. Idempotent: the first revocation is the one that stands. */
export async function revokeFollowUpPermission(
  context: RepositoryContext,
  permissionId: string,
): Promise<SequenceResult<FollowUpPermissionRow>> {
  const { rows } = await context.db.query<PermissionDbRow>(
    `UPDATE follow_up_permissions SET revoked_at = coalesce(revoked_at, now())
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${PERMISSION_COLUMNS}`,
    [context.scope.workspaceId, permissionId],
  );
  const row = rows[0];
  return row === undefined ? refuseSequence('invalid_input') : acceptSequence(toPermission(row));
}

/**
 * Consume the one e-mail a `single_email` permission bought.
 *
 * Called from inside the dispatch claim's transaction, after the fence is claimed and
 * before it commits (`packages/domain/outbound/send.ts`). The brief says "when the send
 * leaves"; the claim is the last committed instant before the bytes *may* leave, and
 * Appendix B is explicit that a claimed fence may have reached Gmail even when the call
 * reports nothing. Consuming at the claim can therefore cost a permission whose e-mail
 * never arrived; consuming after `recordSent` could let a fence in doubt be re-prepared
 * and a second e-mail leave on a permission David said buys one. That is the deviation,
 * and it errs in the direction a send that cannot be taken back should err in.
 *
 * `WHERE consumed_at IS NULL` so it is idempotent; the source has already refused a
 * consumed permission inside this same transaction, so a zero rowcount here is a race
 * the fence's own row lock makes unreachable.
 */
export async function consumeFollowUpPermission(
  context: RepositoryContext,
  permissionId: string,
): Promise<boolean> {
  const consumed = await context.db.query(
    `UPDATE follow_up_permissions SET consumed_at = now()
      WHERE workspace_id = $1 AND id = $2 AND scope = 'single_email' AND consumed_at IS NULL`,
    [context.scope.workspaceId, permissionId],
  );
  return (consumed.rowCount ?? 0) > 0;
}
