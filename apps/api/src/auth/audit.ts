import type { Queryable } from '@fss/domain/db';
import {
  VISIBILITY_OF_READ,
  type ReadVisibilityClass,
  type SensitiveReadKind,
} from '@fss/contracts';

/**
 * Append-only audit events, and the hook the read matrix hangs on
 * (specification 5.2, 10.3 and Appendix F).
 *
 * `audit_events` has `UPDATE`, `DELETE` and `TRUNCATE` revoked from both application
 * roles in migration 0001, so "append-only" here is a privilege rather than a habit:
 * this module can only add.
 *
 * Section 5.2: "Admin reads of message bodies, drafts, mailbox diagnostics, and
 * exports create access audit events." Message bodies, drafts and mailbox diagnostics
 * do not exist yet. The rule that decides when one of those reads is audited does,
 * and it is a pure function, so the slice that adds bodies inherits the decision
 * instead of making it again.
 */

export interface AuditActor {
  readonly userId: string | null;
  readonly role: 'admin' | 'salesperson' | null;
  readonly kind: 'user' | 'admin' | 'system' | 'worker';
}

export interface AuditEventInput {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  readonly action: string;
  readonly subjectKind: string;
  readonly subjectId?: string | null;
  /** Never a message body, a token, an email address or a stack. Identifiers and codes. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Write one audit event. Joins the caller's transaction when `db` is in one. */
export async function recordAuditEvent(db: Queryable, event: AuditEventInput): Promise<void> {
  const actorUserId = event.actor.kind === 'user' || event.actor.kind === 'admin' ? event.actor.userId : null;
  await db.query(
    `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      event.workspaceId,
      event.actor.kind,
      actorUserId,
      event.action,
      event.subjectKind,
      event.subjectId ?? null,
      JSON.stringify(event.detail ?? {}),
    ],
  );
}

/** The actor as `audit_events` wants it, from a principal's role. */
export function actorOf(principal: { readonly userId: string; readonly role: 'admin' | 'salesperson' }): AuditActor {
  return {
    userId: principal.userId,
    role: principal.role,
    kind: principal.role === 'admin' ? 'admin' : 'user',
  };
}

export const SYSTEM_ACTOR: AuditActor = { userId: null, role: null, kind: 'system' };

// ---------------------------------------------------------------------------
// The read matrix
// ---------------------------------------------------------------------------

export interface SensitiveReadRequest {
  readonly kind: SensitiveReadKind;
  readonly actorRole: 'admin' | 'salesperson';
  /** Whether the actor is the assigned salesperson for the firm this row belongs to. */
  readonly actorIsAssignee: boolean;
  /** Whether the actor owns the mailbox this row came from. */
  readonly actorIsMailboxOwner: boolean;
}

export type SensitiveReadDecision =
  | { readonly permitted: true; readonly audited: boolean; readonly visibility: ReadVisibilityClass }
  | { readonly permitted: false; readonly visibility: ReadVisibilityClass };

/**
 * May this actor read this class of row, and does the read create an audit event?
 *
 * Appendix F in one function. An admin may read everything and every admin read of a
 * row they are not the assignee or mailbox owner of is audited; a salesperson reads
 * only their own, and those reads are ordinary work and are not audited. Anything the
 * matrix does not place is refused rather than allowed.
 */
export function decideSensitiveRead(request: SensitiveReadRequest): SensitiveReadDecision {
  const visibility = VISIBILITY_OF_READ[request.kind];
  const ownRow =
    visibility === 'mailbox_owner_or_admin' ? request.actorIsMailboxOwner : request.actorIsAssignee;

  if (request.actorRole === 'admin') {
    // An admin reading someone else's row is the case section 5.2 names. An admin
    // reading their own assigned firm is doing ordinary work.
    return { permitted: true, audited: !ownRow, visibility };
  }
  if (!ownRow) return { permitted: false, visibility };
  return { permitted: true, audited: false, visibility };
}

export interface SensitiveReadRecord extends SensitiveReadRequest {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly subjectKind: string;
  readonly subjectId: string;
}

/**
 * Decide and, when the decision says so, record. Returns the decision so the caller
 * still has to refuse a read the matrix refused — this never returns rows.
 */
export async function recordSensitiveRead(
  db: Queryable,
  record: SensitiveReadRecord,
): Promise<SensitiveReadDecision> {
  const decision = decideSensitiveRead(record);
  if (decision.permitted && decision.audited) {
    await recordAuditEvent(db, {
      workspaceId: record.workspaceId,
      actor: { userId: record.actorUserId, role: record.actorRole, kind: 'admin' },
      action: `read.${record.kind}`,
      subjectKind: record.subjectKind,
      subjectId: record.subjectId,
      detail: { visibility: decision.visibility },
    });
  }
  return decision;
}
