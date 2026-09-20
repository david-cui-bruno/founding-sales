import type { BlockedActionKind, HoldReasonCode, PauseChannel } from '@fss/contracts';

/**
 * What the policy commands share (specification 10.1, 15).
 *
 * The same shape as the CRM's `CrmResult`, and for the same reason: a refusal is a
 * value the command receipt can record, never an exception that would roll the
 * receipt back with the mutation (see `docs/greenfield/crm.md`, rule 2).
 */

export const POLICY_REFUSAL_CODES = [
  'admin_only',
  'not_assigned',
  'firm_unknown',
  'posture_unknown',
  'posture_overlapping',
  'posture_already_revoked',
  'pause_unknown',
  'pause_already_released',
  'callback_unknown',
  'callback_not_open',
  'window_not_narrower',
  'invalid_input',
] as const;
export type PolicyRefusalCode = (typeof POLICY_REFUSAL_CODES)[number];

export type PolicyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: PolicyRefusalCode };

export function acceptPolicy<T>(value: T): PolicyResult<T> {
  return { ok: true, value };
}

export function refusePolicy<T>(reason: PolicyRefusalCode): PolicyResult<T> {
  return { ok: false, reason };
}

/** One open hold, as the policy and dial code reads it. */
export interface OpenHold {
  readonly id: string;
  readonly scopeKind: string;
  readonly scopeKey: string | null;
  readonly reasonCode: HoldReasonCode;
  readonly blockedActionKinds: readonly BlockedActionKind[];
  readonly sourceEventKind: string;
  readonly sourceEventId: string | null;
  readonly ownerUserId: string | null;
  readonly startedAt: string;
  readonly recoveryAction: string | null;
}

/**
 * Which action kinds a channel pause blocks (10.1).
 *
 * "A sending pause does not stop Gmail synchronization, opt-out processing, Today
 * construction, or manual calling unless calling is separately paused." So an
 * `email` pause blocks `email_send` and nothing else, and only a `call` pause — or a
 * pause over all automation — reaches `dial_authorization`.
 */
export const CHANNEL_BLOCKED_ACTION_KINDS: Readonly<Record<PauseChannel, readonly BlockedActionKind[]>> =
  Object.freeze({
    email: Object.freeze(['email_send'] as const),
    call: Object.freeze(['call_task', 'dial_authorization'] as const),
    linkedin: Object.freeze(['linkedin_task'] as const),
    research: Object.freeze(['research'] as const),
  });

/** Everything a pause with no channel blocks. */
export const ALL_BLOCKED_ACTION_KINDS: readonly BlockedActionKind[] = Object.freeze([
  'email_send',
  'call_task',
  'linkedin_task',
  'dial_authorization',
  'enrollment_advance',
  'research',
] as const);
