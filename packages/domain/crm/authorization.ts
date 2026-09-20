import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { CrmRefusalCode, FirmRow } from './types.ts';

/**
 * Who may change a firm, and who may read what about it
 * (specification 5.2, Appendix F, Appendix G 7).
 *
 * "Salesperson: may modify, contact, or enroll only assigned firms." That sentence is
 * this file, and every CRM mutation goes through `decideFirmMutation` after loading
 * the firm `FOR UPDATE` — not before, and not from a cached row. The lock is what
 * makes Appendix G 7's last clause true: during a concurrent reassignment the former
 * assignee's command waits for the reassignment to commit and then reads the new
 * assignee, so it is refused rather than racing in on a stale read.
 */

export type FirmMutationDecision =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly reason: CrmRefusalCode };

/**
 * May this scope change this firm?
 *
 * A merged firm is refused before assignment is even considered: the record is
 * history, and the reason a caller gets back should say so rather than sending them
 * to find out who owns a record that no longer exists.
 */
export function decideFirmMutation(context: RepositoryContext, firm: FirmRow): FirmMutationDecision {
  if (firm.status === 'merged') return { permitted: false, reason: 'firm_merged' };
  const actor = context.scope.actor;
  // The worker and the scheduler act for the system; there is no assignee to compare
  // them with, and every job they run was materialized from business state that this
  // rule already governed.
  if (actor.kind === 'system') return { permitted: true };
  if (actor.role === 'admin') return { permitted: true };
  if (firm.assigned_user_id !== actor.userId) return { permitted: false, reason: 'not_assigned' };
  return { permitted: true };
}

/** Admin-only commands ask this rather than taking the caller's word. */
export function decideAdminOnly(context: RepositoryContext): FirmMutationDecision {
  const actor = context.scope.actor;
  if (actor.kind === 'system') return { permitted: true };
  if (actor.role === 'admin') return { permitted: true };
  return { permitted: false, reason: 'admin_only' };
}

/**
 * Appendix F's first two rows, for a firm.
 *
 * | Data | Any active member | Assigned salesperson or admin |
 * | Firm identity, stage/dates, sequence status, call outcomes without notes | Yes | Yes |
 * | Message bodies, notes, callbacks, FSS drafts | | Yes |
 *
 * Everything a CRM read returns falls in one of those two classes, so the decision is
 * which DTO to build rather than whether to answer. `mailbox_owner_or_admin` is not
 * here: no CRM row is mailbox-private.
 */
export type FirmReadVisibility = 'any_active_member' | 'assigned_or_admin';

export function decideFirmRead(context: RepositoryContext, firm: FirmRow): FirmReadVisibility {
  const actor = context.scope.actor;
  if (actor.kind === 'system') return 'assigned_or_admin';
  if (actor.role === 'admin') return 'assigned_or_admin';
  return firm.assigned_user_id === actor.userId ? 'assigned_or_admin' : 'any_active_member';
}

/**
 * Whether this read creates an access audit event (5.2: "Admin reads of message
 * bodies, drafts, mailbox diagnostics, and exports create access audit events").
 *
 * An admin reading a firm they are not the assignee of is the case that sentence
 * names. A salesperson reading their own assigned firm is ordinary work. This mirrors
 * `decideSensitiveRead` in the API, which owns the same rule for mailbox rows; the
 * two agree because they are the same two clauses, and a test asserts it.
 */
export function firmReadIsAudited(context: RepositoryContext, firm: FirmRow): boolean {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || actor.role !== 'admin') return false;
  return firm.assigned_user_id !== actor.userId;
}
