import type { TodayCardBlocker } from '@fss/contracts';
import type { TodayCard } from '../todayContract.ts';

/**
 * Today's queue, as a pure function of the cards (slice S2; CRM improvement plan §4).
 *
 * The plan fixes the reading order: scheduled callbacks and time-sensitive replies first,
 * then new prospects, then the firms that cannot be called yet, each with its reason. The
 * server's order is kept *inside* every group — `listTodayCards` sorts by lane, due instant
 * and name, and lane 4 puts the call-first firms ahead — so this file only says which group
 * a card belongs to and never sorts within one.
 *
 * Two readings decided here, said once:
 *
 *   * **Callbacks before replies.** The plan's list names callbacks first; the server's
 *     lane precedence puts replies first. A callback is a promise of a time, and the person
 *     on the other end is waiting for the phone to ring at it, so the queue shows it first.
 *   * **A reply stays with the replies whatever it is missing.** Reading and answering a
 *     reply needs no number and no zone; "can't call yet" is for the calls.
 */

export type QueueGroupId = 'callbacks' | 'replies' | 'due' | 'prospects' | 'blocked';

export interface QueueGroup {
  readonly id: QueueGroupId;
  readonly label: string;
  readonly cards: readonly TodayCard[];
}

const LABELS: Readonly<Record<QueueGroupId, string>> = Object.freeze({
  callbacks: 'Callbacks',
  replies: 'Replies waiting',
  due: 'Due today',
  prospects: 'New prospects',
  blocked: 'Can’t call yet',
});

const ORDER: readonly QueueGroupId[] = ['callbacks', 'replies', 'due', 'prospects', 'blocked'];

/** The reasons a card cannot be called, from its own record. Empty from an older API. */
export function blockersOf(card: TodayCard): readonly TodayCardBlocker[] {
  return card.blockers ?? [];
}

export function groupOf(card: TodayCard): QueueGroupId {
  if (card.lane === 'reply') return 'replies';
  if (blockersOf(card).length > 0) return 'blocked';
  if (card.lane === 'callback') return 'callbacks';
  if (card.lane === 'due_work') return 'due';
  return 'prospects';
}

/** The groups that have cards, in the plan's order, each in the server's order. */
export function queueGroups(cards: readonly TodayCard[]): readonly QueueGroup[] {
  return ORDER.map(id => ({ id, label: LABELS[id], cards: cards.filter(card => groupOf(card) === id) })).filter(
    group => group.cards.length > 0,
  );
}

/** Every card in the order the queue shows them: what J and K walk. */
export function queueOrder(cards: readonly TodayCard[]): readonly TodayCard[] {
  return queueGroups(cards).flatMap(group => group.cards);
}

/** One sentence per blocker, the one place each becomes English. */
export const BLOCKER_SENTENCES: Readonly<Record<TodayCardBlocker, string>> = Object.freeze({
  no_phone: 'No phone number',
  no_location: 'No location or time zone',
});

/** What the fix is, for the button beside the reason. */
export const BLOCKER_FIXES: Readonly<Record<TodayCardBlocker, string>> = Object.freeze({
  no_phone: 'Add a phone number',
  no_location: 'Add the state and time zone',
});

/** "No phone number · No location or time zone", or null for a card that can be called. */
export function blockerLine(card: TodayCard): string | null {
  const blockers = blockersOf(card);
  return blockers.length === 0 ? null : blockers.map(code => BLOCKER_SENTENCES[code]).join(' · ');
}

/** The grey line under a firm's name in the queue. */
export function queueLine(card: TodayCard): string {
  const blocked = card.lane === 'reply' ? null : blockerLine(card);
  if (blocked !== null) return blocked;
  if (card.lane === 'callback') return 'Callback';
  if (card.lane === 'reply') return card.counts.replies > 1 ? `${String(card.counts.replies)} replies` : 'Replied';
  if (card.lane === 'due_work') {
    const parts = [
      card.counts.callsDue > 0 ? `${String(card.counts.callsDue)} call${card.counts.callsDue === 1 ? '' : 's'}` : null,
      card.counts.emailsDue > 0 ? `${String(card.counts.emailsDue)} email${card.counts.emailsDue === 1 ? '' : 's'}` : null,
    ].filter((part): part is string => part !== null);
    return parts.length === 0 ? 'Due today' : `Due: ${parts.join(', ')}`;
  }
  return 'Not yet contacted';
}

/**
 * The firm one step away in the queue's order, or null at either end. J and K, and the
 * arrow keys.
 */
export function stepFrom(cards: readonly TodayCard[], firmId: string | null, delta: 1 | -1): string | null {
  const order = queueOrder(cards);
  if (order.length === 0) return null;
  const index = firmId === null ? -1 : order.findIndex(card => card.firmId === firmId);
  if (index === -1) return (delta === 1 ? order[0] : order.at(-1))?.firmId ?? null;
  return order[index + delta]?.firmId ?? null;
}

/**
 * "Next firm" after a call: the first callable firm after this one that has not been
 * called in this sitting, wrapping round to the top; null when there is none. A blocked
 * firm is never the next one — it has nothing to call — and nor is a reply, which is
 * read rather than dialled.
 */
export function nextToCall(cards: readonly TodayCard[], firmId: string | null, done: ReadonlySet<string>): string | null {
  const order = queueOrder(cards);
  const index = firmId === null ? -1 : order.findIndex(card => card.firmId === firmId);
  const rotated = [...order.slice(index + 1), ...order.slice(0, Math.max(index, 0))];
  const candidate = rotated.find(card => {
    const group = groupOf(card);
    return card.firmId !== firmId && !done.has(card.firmId) && group !== 'blocked' && group !== 'replies';
  });
  return candidate?.firmId ?? null;
}
