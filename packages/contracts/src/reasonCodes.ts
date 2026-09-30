import { z } from 'zod';

/**
 * The closed reason-code set of specification section 15.
 *
 * The same set is seeded into `hold_reason_codes` by migration 0001, and
 * packages/domain/test/db/reasonCodes.test.ts compares the two row for row: a code
 * added here without a migration, or the other way round, fails the gate.
 *
 * `recoverable` is section 15's "only explicitly recoverable holds expose controls".
 * A code marked false is not a bug to be fixed by a button; it is a hold that a
 * salesperson must not be able to clear.
 */

export const HOLD_REASON_CODES = [
  'scoped_pause',
  'mailbox_disconnected',
  'coverage_incomplete',
  'template_unapproved',
  /**
   * The bytes that would leave carry a visible opt-out link — from the sign-off, or
   * from a variable's value, neither of which the approval saw (migration 0024). Its
   * own code rather than `template_unapproved` because the operator has to be able to
   * read *why* an approved template stopped, and `hold_reason_code` is the field that
   * is read (review of PR 311, second round).
   */
  'optout_link',
  'missing_variables',
  'daily_cap',
  'route_missing',
  'route_candidate',
  'route_invalid',
  'route_retired',
  'outside_email_window',
  'outside_calling_window',
  'posture_missing',
  'posture_overlapping',
  'posture_overdue',
  'firm_suppressed',
  'handle_suppressed',
  'manual_suppression_review',
  'uncertain_reply',
  'ambiguous_match',
  'reassignment',
  'opportunity_manual',
  'provider_refusal',
  'send_unknown_reconciling',
  'send_unknown_terminal',
  'long_hold_review',
  'restore_in_progress',
  /**
   * Migration 0025, David's send-path decisions of 29 September 2026. Five refusals
   * the corrected send path needs, and each is a sentence an operator reads on a card:
   *
   *   * `cold_legacy` — the enrollment predates evidenced follow-up permissions. Not
   *     recoverable: nothing clears it, and a later valid request is a *new*
   *     enrollment with a new permission, never a revival of this one.
   *   * `follow_up_not_permitted` — no unrevoked permission whose evidence still names
   *     this firm and this recipient. Recoverable: record the evidence, or grant the
   *     permission from the flow that should have granted it.
   *   * `follow_up_expired` — the permission's `expires_at` has passed. Recoverable by
   *     a fresh request, which is a fresh permission.
   *   * `follow_up_scope_exhausted` — the one e-mail a `single_email` permission bought
   *     has left. Not recoverable: there is nothing to clear, only a new permission to
   *     grant, and a control offering to clear it would be a control offering to send
   *     the second e-mail David refused.
   *   * `firm_already_enrolled` — another contact at this firm is already in a live
   *     prospecting sequence. Recoverable: that enrollment ends and this one proceeds.
   */
  'cold_legacy',
  'follow_up_not_permitted',
  'follow_up_expired',
  'follow_up_scope_exhausted',
  'firm_already_enrolled',
  /**
   * Migration 0026, send-path v2 (30 September 2026): a prospecting e-mail may not
   * leave through a conversation (Gmail) mailbox; it is held until a cold-outreach
   * transport dispatches it. A mailbox label never authorises the Gmail path.
   */
  'cold_outreach_mailbox_required',
] as const;

export const holdReasonCodeSchema = z.enum(HOLD_REASON_CODES);
export type HoldReasonCode = z.infer<typeof holdReasonCodeSchema>;

/** Which codes a control may clear. Everything absent from this set is not recoverable. */
const RECOVERABLE_HOLD_REASON_CODES: ReadonlySet<HoldReasonCode> = new Set([
  'scoped_pause',
  'mailbox_disconnected',
  'coverage_incomplete',
  'template_unapproved',
  'optout_link',
  'missing_variables',
  'daily_cap',
  'route_missing',
  'route_candidate',
  'route_invalid',
  'route_retired',
  'outside_email_window',
  'outside_calling_window',
  'uncertain_reply',
  'ambiguous_match',
  'reassignment',
  'provider_refusal',
  'send_unknown_terminal',
  'long_hold_review',
  'follow_up_not_permitted',
  'follow_up_expired',
  'firm_already_enrolled',
  'cold_outreach_mailbox_required',
]);

export function isRecoverableHoldReason(code: HoldReasonCode): boolean {
  return RECOVERABLE_HOLD_REASON_CODES.has(code);
}

/** The action kinds a hold may block (specification 4.3: "blocked action kinds"). */
export const BLOCKED_ACTION_KINDS = [
  'email_send',
  'call_task',
  'dial_authorization',
  'enrollment_advance',
  'research',
] as const;
export const blockedActionKindSchema = z.enum(BLOCKED_ACTION_KINDS);
export type BlockedActionKind = z.infer<typeof blockedActionKindSchema>;

/**
 * The members of a stored `blocked_action_kinds` array this set still knows.
 *
 * LinkedIn was removed on 25 September 2026, and migration 0018 took `linkedin_task`
 * out of every hold; a hold that blocked nothing else blocks `removed`, which
 * `active_holds_blocked_action_kinds_known` admits so that the row stays as history. A
 * reader ignores it rather than handing a Mac a kind no action has.
 */
export function knownBlockedActionKinds(values: readonly string[]): BlockedActionKind[] {
  return values.filter((value): value is BlockedActionKind => (BLOCKED_ACTION_KINDS as readonly string[]).includes(value));
}

/** The recovery controls a hold may expose. `null` means the hold exposes none. */
const HOLD_RECOVERY_ACTIONS = [
  'resume_after_review',
  'reconnect_mailbox',
  'confirm_reply',
  'resolve_ambiguity',
  'release_pause',
  'mark_delivered_or_skipped',
  'advance_generation',
] as const;
export const holdRecoveryActionSchema = z.enum(HOLD_RECOVERY_ACTIONS);

/** The scopes a hold may cover (specification 4.3). */
const HOLD_SCOPE_KINDS = [
  'workspace',
  'owner',
  'mailbox',
  'firm',
  'opportunity',
  'enrollment',
  'channel',
] as const;
export const holdScopeKindSchema = z.enum(HOLD_SCOPE_KINDS);
