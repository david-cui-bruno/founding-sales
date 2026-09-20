/**
 * The Today vocabulary (specification 8.2, 8.3).
 *
 * The same shape as the CRM's `CrmResult` and the policy lane's `PolicyResult`, and
 * for the same reason: a refusal is a value the command receipt can record, never an
 * exception that would roll the receipt back with the mutation.
 */

/** 8.2's four lanes, in precedence order. The array order *is* the precedence. */
export const TODAY_LANES = ['reply', 'callback', 'due_work', 'new_firm'] as const;
export type TodayLane = (typeof TODAY_LANES)[number];

/**
 * What one contact task is.
 *
 * Three kinds share the `due_work` lane because 8.2 names one lane for "due sequence
 * work" and the card counts them separately: "replies, emails due, calls due, and
 * LinkedIn tasks due".
 */
export const TODAY_ITEM_KINDS = [
  'reply',
  'callback',
  'email_due',
  'call_due',
  'linkedin_due',
  'new_firm',
] as const;
export type TodayItemKind = (typeof TODAY_ITEM_KINDS)[number];

export const TODAY_ITEM_STATUSES = ['open', 'snoozed', 'completed', 'cancelled'] as const;
export type TodayItemStatus = (typeof TODAY_ITEM_STATUSES)[number];

/**
 * Which row produced a task.
 *
 * `reply_message` and `step_execution` have no table yet — they are the lanes G7 and
 * G8 own — and they are in the closed set anyway, because the promotion interface
 * those lanes call has to name something the database will accept on the day they
 * arrive, not on the day they are wired in.
 */
export const TODAY_SOURCE_KINDS = ['callback', 'firm', 'reply_message', 'step_execution'] as const;
export type TodaySourceKind = (typeof TODAY_SOURCE_KINDS)[number];

/**
 * Appendix C: the job key is `today:{workspace}:{business_date}:{algorithm}`, so the
 * algorithm version is part of the work's identity. Changing the ordering rules means
 * changing this string, which makes the new build a different job rather than a
 * second attempt at the old one.
 *
 * `today_algorithm_version()` in migration 0008 is the same constant on the database
 * side, and `test/today/today.test.ts` compares them.
 */
export const TODAY_ALGORITHM_VERSION = 'today.1';

export const TODAY_REFUSAL_CODES = [
  'invalid_input',
  'not_assigned',
  'firm_unknown',
  'item_unknown',
  'item_not_open',
  'snooze_reason_required',
  'snooze_return_not_future',
  'snooze_unknown',
  'snooze_already_cancelled',
] as const;
export type TodayRefusalCode = (typeof TODAY_REFUSAL_CODES)[number];

export type TodayResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: TodayRefusalCode };

export function acceptToday<T>(value: T): TodayResult<T> {
  return { ok: true, value };
}

export function refuseToday<T>(reason: TodayRefusalCode): TodayResult<T> {
  return { ok: false, reason };
}

/** The aggregate counts 8.2 puts on a card. */
export interface TodayCounts {
  readonly replies: number;
  readonly emailsDue: number;
  readonly callsDue: number;
  readonly linkedInDue: number;
}

/** One card, as the repository reads it. */
export interface TodayCardRow {
  readonly firmId: string;
  readonly firmName: string;
  readonly snapshotDate: string;
  readonly lane: TodayLane;
  readonly sortAt: string;
  readonly assignedUserId: string | null;
  readonly openItems: number;
  readonly counts: TodayCounts;
  readonly algorithmVersion: string;
}

/** One contact task, as the repository reads it. */
export interface TodayItemRow {
  readonly id: string;
  readonly snapshotDate: string;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly itemKey: string;
  readonly kind: TodayItemKind;
  readonly lane: TodayLane;
  readonly dueAt: string;
  readonly status: TodayItemStatus;
  readonly automated: boolean;
  readonly sourceKind: TodaySourceKind;
  readonly sourceId: string | null;
  readonly snoozeUntil: string | null;
}

/** One active snooze. */
export interface TodaySnoozeRow {
  readonly id: string;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly itemKey: string;
  readonly reason: string;
  readonly returnAt: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly cancelledAt: string | null;
}
