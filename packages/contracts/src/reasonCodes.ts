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
] as const;

export const holdReasonCodeSchema = z.enum(HOLD_REASON_CODES);
export type HoldReasonCode = z.infer<typeof holdReasonCodeSchema>;

/** Which codes a control may clear. Everything absent from this set is not recoverable. */
export const RECOVERABLE_HOLD_REASON_CODES: ReadonlySet<HoldReasonCode> = new Set([
  'scoped_pause',
  'mailbox_disconnected',
  'coverage_incomplete',
  'template_unapproved',
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
export const HOLD_RECOVERY_ACTIONS = [
  'resume_after_review',
  'reconnect_mailbox',
  'confirm_reply',
  'resolve_ambiguity',
  'release_pause',
  'mark_delivered_or_skipped',
  'advance_generation',
] as const;
export const holdRecoveryActionSchema = z.enum(HOLD_RECOVERY_ACTIONS);
export type HoldRecoveryAction = z.infer<typeof holdRecoveryActionSchema>;

/** The scopes a hold may cover (specification 4.3). */
export const HOLD_SCOPE_KINDS = [
  'workspace',
  'owner',
  'mailbox',
  'firm',
  'opportunity',
  'enrollment',
  'channel',
] as const;
export const holdScopeKindSchema = z.enum(HOLD_SCOPE_KINDS);
export type HoldScopeKind = z.infer<typeof holdScopeKindSchema>;
