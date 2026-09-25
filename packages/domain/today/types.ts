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
  // Lane g79: a manual task's snooze needs its return instant; an automated task's
  // pause does not, and is released by a person rather than by a clock.
  'snooze_return_required',
  'pause_unknown',
  'pause_already_released',
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

/**
 * A recorded "call me back" that has no confirmed instant yet (lane g79, audit C13).
 *
 * 9.1 creates a callback only "after salesperson confirmation of the instant", and
 * "call logging ... never refuses history". Both hold when a callback request without
 * a time is recorded as a call and shown on Today as its own task until a time is set:
 * lane 2, kind `callback`, keyed by the call that asked for it. `source_kind` is
 * `callback` because the callback source is what produces and reconciles it, and
 * `source_id` is null because there is no callback row yet — the key is the identity.
 * See `docs/decisions/g79-calls-carry-their-authorization.md`.
 */
export const CALLBACK_TIME_NEEDED_KEY_PREFIX = 'callback-time:';

export function callbackTimeNeededItemKey(callLogId: string): string {
  return `${CALLBACK_TIME_NEEDED_KEY_PREFIX}${callLogId}`;
}

/** The call log behind a needs-a-time task, or null for every other key. */
export function callLogIdOfItemKey(itemKey: string): string | null {
  return itemKey.startsWith(CALLBACK_TIME_NEEDED_KEY_PREFIX)
    ? itemKey.slice(CALLBACK_TIME_NEEDED_KEY_PREFIX.length)
    : null;
}

/**
 * The `source_event_kind` of the hold a paused automated task opens (8.2, lane g79).
 * One constant, because the pause, its release and the card that shows it must all
 * recognise the same holds and no others.
 */
export const TODAY_PAUSE_SOURCE_EVENT_KIND = 'today.delay_requested';
