import type { ReplySummary } from '../replyContract.ts';

/**
 * The reply queue as a pure function of the lane's summaries (S4R).
 *
 * The lane arrives as one line per message (`replySummarySchema`): who, when, what Callie
 * suggested and what was confirmed. Nothing here reads a body. Three things are decided:
 *
 * - **What is waiting.** A reply waits while nobody has answered it and the next step is a
 *   person's: answering it, or saying which conversation it belongs to. A delivery failure
 *   is not a reply to answer, and an answered one is done.
 * - **What is uncertain.** A waiting reply with no suggestion at all is counted apart, so
 *   "3 waiting" is never padded by messages Callie could not read. (The summary carries no
 *   class or confidence — those are on the open card — so "no suggestion" is the only
 *   uncertainty the queue can honestly name.)
 * - **The order.** Waiting first, newest first; then the rest, newest first. Stable, so
 *   messages at the same instant keep the server's order.
 */

export type QueueFilter = 'all' | 'waiting' | 'unsure';

export function isWaiting(card: ReplySummary): boolean {
  return card.confirmedDisposition === null && (card.nextAction === 'confirm_disposition' || card.nextAction === 'resolve_ambiguity');
}

/** Waiting, and Callie has no suggestion to start from. */
export function isUnsure(card: ReplySummary): boolean {
  return card.nextAction === 'confirm_disposition' && isWaiting(card) && card.proposedDisposition === null;
}

export function orderQueue(cards: readonly ReplySummary[]): readonly ReplySummary[] {
  const rank = (card: ReplySummary): number => (isWaiting(card) ? 0 : 1);
  return cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => {
      const byRank = rank(a.card) - rank(b.card);
      if (byRank !== 0) return byRank;
      const byTime = Date.parse(b.card.receivedAt) - Date.parse(a.card.receivedAt);
      if (Number.isFinite(byTime) && byTime !== 0) return byTime;
      return a.index - b.index;
    })
    .map(entry => entry.card);
}

export interface QueueCounts {
  /** Waiting, with a suggestion (or a conversation to choose): the count that is firm. */
  readonly waiting: number;
  /** Waiting, with nothing suggested: shown apart. */
  readonly unsure: number;
  readonly all: number;
}

export function countQueue(cards: readonly ReplySummary[]): QueueCounts {
  const unsure = cards.filter(isUnsure).length;
  return { waiting: cards.filter(isWaiting).length - unsure, unsure, all: cards.length };
}

export function filterQueue(cards: readonly ReplySummary[], filter: QueueFilter): readonly ReplySummary[] {
  if (filter === 'all') return cards;
  if (filter === 'unsure') return cards.filter(isUnsure);
  return cards.filter(card => isWaiting(card) && !isUnsure(card));
}

/**
 * The reply to open after one was answered: the next waiting one below it in the queue,
 * else the first waiting one anywhere, else nothing. The answered message itself is never
 * chosen, even if the lane still lists it as waiting.
 */
export function nextAfter(cards: readonly ReplySummary[], answeredId: string): string | null {
  const ordered = orderQueue(cards);
  const at = ordered.findIndex(card => card.messageId === answeredId);
  const waiting = ordered.filter(card => isWaiting(card) && card.messageId !== answeredId);
  if (waiting.length === 0) return null;
  const below = at < 0 ? undefined : ordered.slice(at + 1).find(card => isWaiting(card) && card.messageId !== answeredId);
  return (below ?? waiting[0])?.messageId ?? null;
}

export function queueFilterOf(text: string): QueueFilter {
  return text === 'waiting' || text === 'unsure' ? text : 'all';
}
