import {
  FOLLOW_UP_PERMISSION_WINDOW_DAYS,
  type FollowUpGrantRule,
  type FollowUpPermissionDto,
  type FollowUpPermissionKind,
  type FollowUpPermissionScope,
} from '@fss/contracts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
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
  readonly templateVersionId: string | null;
  readonly sequenceVersionId: string | null;
  readonly enrollmentId: string | null;
  readonly maxSteps: number | null;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly grantedByUserId: string | null;
  readonly grantedByRule: string | null;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly note: string | null;
}

const PERMISSION_COLUMNS = `id, firm_id, contact_id, kind, scope, call_log_id, mail_message_id,
  booking_reference, template_version_id, sequence_version_id, enrollment_id, max_steps,
  granted_at, expires_at, granted_by_user_id, granted_by_rule, consumed_at, revoked_at, note`;

interface PermissionDbRow {
  readonly id: string;
  readonly firm_id: string;
  readonly contact_id: string;
  readonly kind: FollowUpPermissionKind;
  readonly scope: FollowUpPermissionScope;
  readonly call_log_id: string | null;
  readonly mail_message_id: string | null;
  readonly booking_reference: string | null;
  readonly template_version_id: string | null;
  readonly sequence_version_id: string | null;
  readonly enrollment_id: string | null;
  readonly max_steps: number | null;
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
    templateVersionId: row.template_version_id,
    sequenceVersionId: row.sequence_version_id,
    enrollmentId: row.enrollment_id,
    maxSteps: row.max_steps === null ? null : Number(row.max_steps),
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
  input: {
    readonly firmId?: string | undefined;
    readonly contactId?: string | undefined;
    /**
     * Answer only about the firms this user is assigned (P1-5 of the GPT-6 review of PR
     * 332). A list with no firm id used to be a list of the whole workspace, which is a
     * wider read than the firm page gives the same caller; the filter is here rather than
     * in the route so that it is part of the query that reads the rows.
     */
    readonly assignedToUserId?: string | undefined;
  } = {},
): Promise<readonly FollowUpPermissionRow[]> {
  const { rows } = await context.db.query<PermissionDbRow>(
    `SELECT ${PERMISSION_COLUMNS} FROM follow_up_permissions p
      WHERE p.workspace_id = $1
        AND ($2::uuid IS NULL OR p.firm_id = $2)
        AND ($3::uuid IS NULL OR p.contact_id = $3)
        AND ($4::uuid IS NULL OR EXISTS (
              SELECT 1 FROM firms f
               WHERE f.workspace_id = p.workspace_id AND f.id = p.firm_id
                 AND f.assigned_user_id = $4))
      ORDER BY p.granted_at DESC, p.id`,
    [context.scope.workspaceId, input.firmId ?? null, input.contactId ?? null, input.assignedToUserId ?? null],
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
   * The **published version** the step's enrollment runs. `agreed_sequence` is permitted
   * for one immutable version, never for a sequence: expiry is computed from a version's
   * own steps, so a later version of the same sequence is a different agreement
   * (GPT-6 review of PR 332, P0-3).
   */
  readonly sequenceVersionId?: string | null | undefined;
  /** The enrollment this step belongs to, which must be the one the permission bought. */
  readonly enrollmentId?: string | null | undefined;
  /** How many steps the enrollment has, against `max_steps`. */
  readonly stepCount?: number | undefined;
  /**
   * The template version whose bytes would leave. Checked against the permitted one for
   * `single_email`: "the agreed overview", not "whatever approved template was picked".
   */
  readonly templateVersionId?: string | null | undefined;
}

/**
 * Whether this permission authorizes writing to this person, now.
 *
 * The questions, in the order a refusal is most worth reading:
 *
 *   1. the row exists, and belongs to this workspace (the scope does that);
 *   2. it names **this** firm and **this** recipient;
 *   3. it has not been revoked;
 *   4. its evidence row still exists, still names the same firm and the same person,
 *      **and still records the agreement this permission claims** — the question that
 *      makes this a verification rather than a label read;
 *   5. it has not expired;
 *   6. its scope still has room: `single_email` and `contextual_reply` once each and
 *      bound to their own content, `agreed_sequence` for its own immutable version and
 *      its own run within `max_steps`, and `booking_communications` **never** — reserved
 *      until a booking table exists.
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

  // The run. A permission buys **one** enrollment, and `enrollContact` binds it; a step
  // of any other enrollment is the reuse P0-3 named, whatever its scope.
  if (
    permission.enrollmentId !== null &&
    subject.enrollmentId !== undefined &&
    subject.enrollmentId !== null &&
    permission.enrollmentId !== subject.enrollmentId
  ) {
    return { ok: false, refusal: 'follow_up_scope_exhausted', detail: 'another_enrollment' };
  }
  switch (permission.scope) {
    case 'single_email':
    case 'contextual_reply':
      // One message each, and the claim spends it (`consumeFollowUpPermission`).
      if (permission.consumedAt !== null) {
        return { ok: false, refusal: 'follow_up_scope_exhausted', detail: 'already_sent' };
      }
      // And for a single e-mail, the bytes are the agreed bytes.
      if (
        permission.scope === 'single_email' &&
        subject.templateVersionId !== undefined &&
        subject.templateVersionId !== null &&
        permission.templateVersionId !== subject.templateVersionId
      ) {
        return { ok: false, refusal: 'follow_up_not_permitted', detail: 'another_template' };
      }
      break;
    case 'agreed_sequence':
      if (
        subject.sequenceVersionId !== undefined &&
        subject.sequenceVersionId !== null &&
        permission.sequenceVersionId !== subject.sequenceVersionId
      ) {
        return { ok: false, refusal: 'follow_up_scope_exhausted', detail: 'another_version' };
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

  // The step limit last of the three, because "that permission is not for this plan"
  // is a more useful sentence than "this plan is too long" when both are true.
  if (
    permission.maxSteps !== null &&
    subject.stepCount !== undefined &&
    subject.stepCount > permission.maxSteps
  ) {
    return {
      ok: false,
      refusal: 'follow_up_scope_exhausted',
      detail: `steps:${String(subject.stepCount)}>${String(permission.maxSteps)}`,
    };
  }


  return { ok: true, permission };
}

/**
 * The evidence row, re-read. `null` when it is sound; otherwise the detail of the
 * refusal.
 *
 * **A call log** must be a conversation (`outcome = 'interested'`), must name this firm
 * and — since P0-1 — **this person by name**: a log with a null `contact_id` is a call
 * to a main line and is evidence about a firm, not consent from somebody. And it must
 * record *what* was agreed: `agreed_follow_up` with the template version or the sequence
 * version the permission claims. A `callback_requested` log therefore cannot support a
 * permission through any API, which is David's "'Call me Tuesday' means a callback
 * task" enforced where it cannot be routed around.
 *
 * **An inbound e-mail**: `mail_messages` carries no firm, so the evidence is the
 * confirmation a person made — a `mail_reply_confirmations` row for this message, at
 * this firm, with a disposition that asks to be written to, and **no callback
 * committed** (a `follow_up_later` that booked a call is a call, not an e-mail). The
 * match that names the recipient must be the chosen one: `selected = true`, or the only
 * match the message has. A match a merge re-pointed or a deletion removed withdraws the
 * permission without anybody having to remember to. The direction is `incoming`
 * (migration 0009's vocabulary; the verification document of 29 September says
 * "inbound", which is the same thing in English and not in SQL).
 */
async function verifyEvidence(
  context: RepositoryContext,
  permission: FollowUpPermissionRow,
): Promise<string | null> {
  if (permission.callLogId !== null) {
    const { rows } = await context.db.query<{
      firm_id: string;
      contact_id: string | null;
      outcome: string;
      agreed_follow_up: string | null;
      agreed_template_version_id: string | null;
      agreed_sequence_version_id: string | null;
    }>(
      `SELECT firm_id, contact_id, outcome, agreed_follow_up,
              agreed_template_version_id, agreed_sequence_version_id
         FROM call_logs WHERE workspace_id = $1 AND id = $2`,
      [context.scope.workspaceId, permission.callLogId],
    );
    const log = rows[0];
    if (log === undefined) return 'call_log_missing';
    if (log.firm_id !== permission.firmId) return 'call_log_firm_mismatch';
    if (log.contact_id === null) return 'call_log_names_no_person';
    if (log.contact_id !== permission.contactId) return 'call_log_contact_mismatch';
    if (log.outcome !== 'interested') return `call_outcome_${log.outcome}`;
    if (log.agreed_follow_up === null) return 'call_agreed_nothing';
    if (log.agreed_follow_up !== permission.scope) return `call_agreed_${log.agreed_follow_up}`;
    if (
      permission.scope === 'single_email' &&
      log.agreed_template_version_id !== permission.templateVersionId
    ) {
      return 'call_agreed_another_template';
    }
    if (
      permission.scope === 'agreed_sequence' &&
      log.agreed_sequence_version_id !== permission.sequenceVersionId
    ) {
      return 'call_agreed_another_version';
    }
    return null;
  }
  if (permission.mailMessageId !== null) {
    if (permission.scope !== 'contextual_reply') return 'mail_permits_only_a_reply';
    const { rows } = await context.db.query<{ matched: boolean }>(
      `SELECT true AS matched
         FROM mail_reply_confirmations c
         JOIN mail_messages mm ON mm.workspace_id = c.workspace_id AND mm.id = c.mail_message_id
         JOIN mail_message_matches m
              ON m.workspace_id = c.workspace_id AND m.mail_message_id = c.mail_message_id
             AND m.firm_id = c.firm_id
             AND (m.selected IS TRUE
                  OR NOT EXISTS (SELECT 1 FROM mail_message_matches other
                                  WHERE other.workspace_id = m.workspace_id
                                    AND other.mail_message_id = m.mail_message_id
                                    AND other.id <> m.id))
        WHERE c.workspace_id = $1
          AND c.mail_message_id = $2
          AND c.firm_id = $3
          AND c.disposition IN ('interested', 'follow_up_later')
          AND c.callback_id IS NULL
          AND m.contact_id = $4
          AND mm.direction = 'incoming'
        LIMIT 1`,
      [context.scope.workspaceId, permission.mailMessageId, permission.firmId, permission.contactId],
    );
    return rows[0] === undefined ? 'inbound_request_unconfirmed' : null;
  }
  // `follow_up_permissions_one_evidence` leaves only the booking reference, and the
  // scope arm above refuses it before anything can rest on it.
  return 'booking_scope_reserved';
}

// ---------------------------------------------------------------------------
// Granting
// ---------------------------------------------------------------------------

export interface GrantFollowUpPermissionInput {
  readonly firmId: string;
  readonly contactId: string;
  /** Exactly one of the three. The evidence decides the kind and the scope. */
  readonly callLogId?: string | undefined;
  readonly mailMessageId?: string | undefined;
  readonly bookingReference?: string | undefined;
  readonly note?: string | undefined;
  /** A person, or one of `FOLLOW_UP_GRANT_RULES` when the flow itself is the granter. */
  readonly grantedByUserId?: string | undefined;
  readonly grantedByRule?: FollowUpGrantRule | undefined;
  /** Overrides the scope's default window. The only caller that needs it is a test. */
  readonly expiresAt?: string | undefined;
}

/** What one piece of evidence supports: the kind, the scope and what it binds to. */
interface EvidenceTerms {
  readonly kind: FollowUpPermissionKind;
  readonly scope: FollowUpPermissionScope;
  readonly templateVersionId: string | null;
  readonly sequenceVersionId: string | null;
  readonly maxSteps: number | null;
}

/**
 * Grant one permission.
 *
 * **The evidence decides the kind and the scope**, and the caller may not name them
 * (P0-1): a client that could would be a client that could ask for `agreed_sequence` on
 * a callback log. The command reads the evidence row, derives what it supports, refuses
 * when it supports nothing, and then asks `verifyFollowUpPermission` of the row it
 * stored — so the verification is asked at both ends and a permission that could never
 * authorize anything is never written.
 *
 * Authorization is here rather than in the route, under the firm's own row lock, which
 * is this codebase's rule: "no route decides whether a caller is the assignee — the
 * domain command does, under the row lock" (P1-5).
 */
export async function grantFollowUpPermission(
  context: RepositoryContext,
  input: GrantFollowUpPermissionInput,
): Promise<SequenceResult<FollowUpPermissionRow>> {
  if ((input.grantedByUserId === undefined) === (input.grantedByRule === undefined)) {
    return refuseSequence('invalid_input');
  }
  const named = [input.callLogId, input.mailMessageId, input.bookingReference].filter(
    value => value !== undefined,
  );
  if (named.length !== 1) return refuseSequence('invalid_input');

  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuseSequence('firm_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) {
    return refuseSequence(permitted.reason === 'not_assigned' ? 'not_assigned' : 'invalid_input');
  }

  const terms = await termsOfEvidence(context, input);
  if (terms === null) return refuseSequence('follow_up_not_permitted');

  const { rows: clock } = await context.db.query<{ now: Date }>('SELECT now() AS now');
  const grantedAt = (clock[0]?.now ?? new Date()).toISOString();
  const expiry = input.expiresAt ?? (await defaultExpiry(context, terms, input.firmId, grantedAt));
  if (expiry === null) return refuseSequence('version_unknown');

  const { rows } = await context.db.query<PermissionDbRow>(
    `INSERT INTO follow_up_permissions
       (workspace_id, firm_id, contact_id, kind, scope, call_log_id, mail_message_id, booking_reference,
        template_version_id, sequence_version_id, max_steps, granted_at, expires_at,
        granted_by_user_id, granted_by_rule, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, $14, $15, $16)
     RETURNING ${PERMISSION_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.contactId,
      terms.kind,
      terms.scope,
      input.callLogId ?? null,
      input.mailMessageId ?? null,
      input.bookingReference ?? null,
      terms.templateVersionId,
      terms.sequenceVersionId,
      terms.maxSteps,
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
  });
  if (!verdict.ok && verdict.detail !== 'booking_scope_reserved') {
    throw new FollowUpEvidenceError(verdict.detail);
  }
  return acceptSequence(permission);
}

/**
 * What the named evidence supports, or null when it supports nothing.
 *
 * A call log supports exactly what it recorded as agreed — the `agreed_follow_up`
 * column and the version it names — and nothing when it recorded no agreement or was
 * not a conversation. An inbound message supports one contextual reply. A booking
 * reference supports the reserved scope, which the verification then refuses.
 */
async function termsOfEvidence(
  context: RepositoryContext,
  input: GrantFollowUpPermissionInput,
): Promise<EvidenceTerms | null> {
  if (input.callLogId !== undefined) {
    const { rows } = await context.db.query<{
      outcome: string;
      agreed_follow_up: string | null;
      agreed_template_version_id: string | null;
      agreed_sequence_version_id: string | null;
    }>(
      `SELECT outcome, agreed_follow_up, agreed_template_version_id, agreed_sequence_version_id
         FROM call_logs WHERE workspace_id = $1 AND id = $2`,
      [context.scope.workspaceId, input.callLogId],
    );
    const log = rows[0];
    if (log === undefined || log.outcome !== 'interested' || log.agreed_follow_up === null) return null;
    if (log.agreed_follow_up === 'single_email') {
      return {
        kind: 'conversation',
        scope: 'single_email',
        templateVersionId: log.agreed_template_version_id,
        sequenceVersionId: null,
        maxSteps: 1,
      };
    }
    const versionId = log.agreed_sequence_version_id;
    if (versionId === null) return null;
    return {
      kind: 'agreed_sequence',
      scope: 'agreed_sequence',
      templateVersionId: null,
      sequenceVersionId: versionId,
      maxSteps: await stepCountOfVersion(context, versionId),
    };
  }
  if (input.mailMessageId !== undefined) {
    return {
      kind: 'request',
      scope: 'contextual_reply',
      templateVersionId: null,
      sequenceVersionId: null,
      maxSteps: 1,
    };
  }
  return {
    kind: 'booking',
    scope: 'booking_communications',
    templateVersionId: null,
    sequenceVersionId: null,
    maxSteps: null,
  };
}

async function stepCountOfVersion(context: RepositoryContext, versionId: string): Promise<number> {
  const { rows } = await context.db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM sequence_steps WHERE workspace_id = $1 AND sequence_version_id = $2',
    [context.scope.workspaceId, versionId],
  );
  return Math.max(1, Number(rows[0]?.count ?? '1'));
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
 * `agreed_sequence` — the instant the agreed version's last step would have been due.
 *
 * "An agreed follow-up sequence can run within its agreed scope" is a length as well as
 * a name, and since P0-3 it is the length of **the version named in the permission**
 * rather than of whatever is published when the step runs.
 */
async function defaultExpiry(
  context: RepositoryContext,
  terms: EvidenceTerms,
  firmId: string,
  grantedAt: string,
): Promise<string | null> {
  const days = FOLLOW_UP_PERMISSION_WINDOW_DAYS[terms.scope];
  if (days !== null) {
    return new Date(Date.parse(grantedAt) + days * 24 * 60 * 60 * 1000).toISOString();
  }
  const versionId = terms.sequenceVersionId;
  if (versionId === null) return null;
  const { rows } = await context.db.query<{ time_zone: string | null }>(
    'SELECT time_zone FROM firms WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, firmId],
  );
  const version = await readSequenceVersion(context, versionId);
  if (version === null || version.steps.length === 0) return null;
  return agreedSequenceExpiry(version.steps, grantedAt, rows[0]?.time_zone ?? 'America/New_York');
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

/**
 * Revoke a permission. Idempotent: the first revocation is the one that stands.
 *
 * **Through the send gate, exclusively** (P0-4). A revocation is a stop fact, and every
 * stop fact takes `lockSendGateForStopFact` before it writes a row
 * (`packages/domain/policy/sendGate.ts`): a dispatch claim holds the same gate *shared*
 * for the whole of its transaction, so a revocation either commits before the claim
 * reads the permission or waits until after the claim has committed. Without it the
 * revocation could land between the claim's recheck and its commit, and a revoked
 * permission's e-mail would go to Gmail.
 *
 * The caller authorizes under the firm's lock, after the gate, which is the order every
 * stop-fact writer keeps.
 */
export async function revokeFollowUpPermission(
  context: RepositoryContext,
  permissionId: string,
): Promise<SequenceResult<FollowUpPermissionRow>> {
  await lockSendGateForStopFact(context);
  const existing = await readFollowUpPermission(context, permissionId);
  if (existing === null) return refuseSequence('invalid_input');
  const firm = await loadFirmForUpdate(context, existing.firmId);
  if (firm === null) return refuseSequence('firm_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) {
    return refuseSequence(permitted.reason === 'not_assigned' ? 'not_assigned' : 'invalid_input');
  }
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
 * Bind a permission to the one run it paid for.
 *
 * Called by `enrollContact` inside its transaction, immediately after the enrollment
 * exists. Conditional on `enrollment_id IS NULL`, so a second enrollment on the same
 * permission affects no row and the caller refuses: that is "reject reuse" (P0-3), and
 * `follow_up_permissions_one_enrollment` is the same rule in the database.
 */
export async function bindFollowUpPermission(
  context: RepositoryContext,
  permissionId: string,
  enrollmentId: string,
): Promise<boolean> {
  const bound = await context.db.query(
    `UPDATE follow_up_permissions SET enrollment_id = $3
      WHERE workspace_id = $1 AND id = $2 AND enrollment_id IS NULL`,
    [context.scope.workspaceId, permissionId, enrollmentId],
  );
  return (bound.rowCount ?? 0) > 0;
}

/**
 * Spend the one message a `single_email` or a `contextual_reply` permission bought, and
 * say whether the spend was legitimate at the instant it happened.
 *
 * Called from inside the dispatch claim's transaction, after the fence is claimed and
 * before it commits (`packages/domain/outbound/send.ts`), **on a row this transaction
 * has locked**. The UPDATE carries the whole of the permission's liveness — unrevoked,
 * unexpired against the database's own `clock_timestamp()`, unspent — so a revocation or
 * an expiry that lands during a long claim is caught by the write rather than by the read
 * that preceded it, and zero affected rows aborts the claim (P0-4, and P2-1 with it).
 *
 * Why here rather than after `recordSent`: Appendix B says a claimed fence may have
 * reached Gmail even when the call reports nothing, and a fence in doubt is re-decided
 * later. Consuming at the claim can cost a permission whose e-mail never arrived;
 * consuming after the provider answered could let a second e-mail leave on a permission
 * that buys one. `docs/greenfield/decisions/follow-up-eligibility-20260929.md` records
 * the choice.
 */
export async function consumeFollowUpPermission(
  context: RepositoryContext,
  permissionId: string,
): Promise<boolean> {
  const consumed = await context.db.query(
    `UPDATE follow_up_permissions SET consumed_at = now()
      WHERE workspace_id = $1 AND id = $2
        AND scope IN ('single_email', 'contextual_reply')
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > clock_timestamp()`,
    [context.scope.workspaceId, permissionId],
  );
  return (consumed.rowCount ?? 0) > 0;
}

/**
 * Lock the permission a fence's enrollment rests on, for the claim (P0-4).
 *
 * Returns the locked row, or null when the enrollment has none — a `prospecting` or a
 * `cold_legacy` enrollment, which the sources have already decided about. Taken inside
 * the claim transaction, after the fence and the enrollment, so the order is the one
 * `docs/greenfield/decisions/follow-up-eligibility-20260929.md` writes down.
 */
export async function lockPermissionForClaim(
  context: RepositoryContext,
  outboundMessageId: string,
): Promise<FollowUpPermissionRow | null> {
  const { rows } = await context.db.query<PermissionDbRow>(
    `SELECT ${PERMISSION_COLUMNS.split(',').map(name => `p.${name.trim()}`).join(', ')}
       FROM outbound_messages f
       JOIN step_executions e ON e.workspace_id = f.workspace_id AND e.id = f.step_execution_id
       JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
       JOIN follow_up_permissions p ON p.workspace_id = n.workspace_id AND p.id = n.permission_id
      WHERE f.workspace_id = $1 AND f.id = $2 AND n.origin_kind = 'follow_up'
      FOR UPDATE OF p`,
    [context.scope.workspaceId, outboundMessageId],
  );
  const row = rows[0];
  return row === undefined ? null : toPermission(row);
}
