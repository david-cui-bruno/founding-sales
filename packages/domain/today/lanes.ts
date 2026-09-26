import type { TodayCounts } from './types.ts';
import { TODAY_LANES, type TodayItemKind, type TodayLane } from '@fss/contracts';

/**
 * Lane precedence and ordering (specification 8.2), as pure functions.
 *
 * "Lane precedence is: 1 Replies, including uncertain and ambiguous messages;
 * 2 Callbacks; 3 Due sequence work; 4 New firms." and "Within a lane, ordering is due
 * instant, firm name, and firm ID."
 *
 * These are the same rules `today_refresh_card` and the ordered read apply in SQL.
 * They are written here as well because the acceptance criterion for this lane is a
 * *property* — the comparator is a total order, so a sort of the same cards always
 * produces the same list — and a property test needs a function it can call a hundred
 * thousand times without a database.
 *
 * The last tiebreak is the firm id, and it is what makes the order total. A
 * comparator that stopped at the firm name would return 0 for two firms with the same
 * name and leave their order to the sort implementation, which is precisely the
 * "the refresh reshuffled my list" complaint.
 */

export const LANE_PRECEDENCE: Readonly<Record<TodayLane, number>> = Object.freeze(
  Object.fromEntries(TODAY_LANES.map((lane, index) => [lane, index + 1])) as Record<TodayLane, number>,
);

const LANE_OF_KIND: Readonly<Record<TodayItemKind, TodayLane>> = Object.freeze({
  reply: 'reply',
  callback: 'callback',
  email_due: 'due_work',
  call_due: 'due_work',
  new_firm: 'new_firm',
});

export function laneOfItemKind(kind: TodayItemKind): TodayLane {
  return LANE_OF_KIND[kind];
}

export { TODAY_LANES };
export type { TodayItemKind, TodayLane };

/** What the card comparator needs, and nothing else. */
export interface TodayCardOrder {
  readonly lane: TodayLane;
  readonly sortAt: string;
  readonly firmName: string;
  readonly firmId: string;
}

/** What the task comparator needs. `itemKey` is the tiebreak, for the reason above. */
export interface TodayItemOrder {
  readonly kind: TodayItemKind;
  readonly dueAt: string;
  readonly itemKey: string;
}

const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * 8.2's card order: lane precedence, then due instant, then firm name, then firm ID.
 *
 * The instants are compared as parsed milliseconds rather than as strings, because
 * `2026-09-21T09:00:00Z` and `2026-09-21T05:00:00-04:00` are the same instant written
 * two ways and a string comparison would put one before the other.
 */
export function compareTodayCards(left: TodayCardOrder, right: TodayCardOrder): number {
  const byLane = LANE_PRECEDENCE[left.lane] - LANE_PRECEDENCE[right.lane];
  if (byLane !== 0) return byLane;
  const byInstant = Date.parse(left.sortAt) - Date.parse(right.sortAt);
  if (byInstant !== 0) return byInstant;
  const byName = compareStrings(left.firmName, right.firmName);
  if (byName !== 0) return byName;
  return compareStrings(left.firmId, right.firmId);
}

/** 8.2's expanded order: "contact-level tasks ordered by lane precedence and due instant". */
export function compareTodayItems(left: TodayItemOrder, right: TodayItemOrder): number {
  const byLane = LANE_PRECEDENCE[laneOfItemKind(left.kind)] - LANE_PRECEDENCE[laneOfItemKind(right.kind)];
  if (byLane !== 0) return byLane;
  const byInstant = Date.parse(left.dueAt) - Date.parse(right.dueAt);
  if (byInstant !== 0) return byInstant;
  return compareStrings(left.itemKey, right.itemKey);
}

export interface AggregatedCard {
  readonly lane: TodayLane;
  readonly sortAt: string;
  readonly counts: TodayCounts & { readonly open: number };
}

/**
 * The card one firm's unfinished items produce, or null when none are unfinished.
 *
 * "The firm's lane and sort instant come from its highest-priority and earliest-due
 * unfinished item." Null rather than an empty card: a firm with nothing to do is not
 * on the list, and returning a card with a lane nobody chose would put it there.
 */
export function aggregateCard(items: readonly TodayItemOrder[]): AggregatedCard | null {
  if (items.length === 0) return null;
  const first = [...items].sort(compareTodayItems)[0];
  if (first === undefined) return null;
  const count = (kind: TodayItemKind): number => items.filter(item => item.kind === kind).length;
  return {
    lane: laneOfItemKind(first.kind),
    sortAt: first.dueAt,
    counts: {
      replies: count('reply'),
      emailsDue: count('email_due'),
      callsDue: count('call_due'),
      open: items.length,
    },
  };
}
