import { describe, expect, it } from 'vitest';
import {
  LANE_PRECEDENCE,
  TODAY_LANES,
  aggregateCard,
  compareTodayCards,
  compareTodayItems,
  laneOfItemKind,
  type TodayCardOrder,
  type TodayItemOrder,
} from '../../today/lanes.ts';

/**
 * The ordering rules of section 8.2, as pure functions.
 *
 * "Lane precedence is: 1 Replies, including uncertain and ambiguous messages;
 * 2 Callbacks; 3 Due sequence work; 4 New firms." and "Within a lane, ordering is
 * due instant, firm name, and firm ID."
 *
 * A sort is only deterministic when its comparator is a total order, so the
 * properties below are the real acceptance criterion: antisymmetric, transitive, and
 * never zero for two different cards. A comparator that returns 0 for two distinct
 * firms leaves their relative order to the sort implementation, which is exactly the
 * "the refresh reshuffled my list" complaint.
 */

/** A tiny deterministic generator, so a failure is reproducible from its seed. */
function randoms(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const CARD_NAMES = ['Alpha Test Co', 'Beta Test Co', 'Gamma Test Co'];
const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const INSTANTS = ['2026-09-21T09:00:00.000Z', '2026-09-21T13:30:00.000Z', '2026-09-21T17:00:00.000Z'];

function everyCard(): readonly TodayCardOrder[] {
  const cards: TodayCardOrder[] = [];
  for (const lane of TODAY_LANES) {
    for (const sortAt of INSTANTS) {
      for (const firmName of CARD_NAMES) {
        for (const firmId of IDS) cards.push({ lane, sortAt, firmName, firmId });
      }
    }
  }
  return cards;
}

describe('lane precedence', () => {
  it('is replies, callbacks, due sequence work, new firms', () => {
    expect(TODAY_LANES).toEqual(['reply', 'callback', 'due_work', 'new_firm']);
    expect(LANE_PRECEDENCE).toEqual({ reply: 1, callback: 2, due_work: 3, new_firm: 4 });
  });

  it('puts every kind of due sequence work in one lane', () => {
    expect(laneOfItemKind('reply')).toBe('reply');
    expect(laneOfItemKind('callback')).toBe('callback');
    expect(laneOfItemKind('email_due')).toBe('due_work');
    expect(laneOfItemKind('call_due')).toBe('due_work');
    expect(laneOfItemKind('new_firm')).toBe('new_firm');
  });
});

describe('the card comparator is a total order', () => {
  const cards = everyCard();

  it('never calls two different cards equal', () => {
    for (const left of cards) {
      for (const right of cards) {
        const answer = compareTodayCards(left, right);
        const same =
          left.lane === right.lane &&
          left.sortAt === right.sortAt &&
          left.firmName === right.firmName &&
          left.firmId === right.firmId;
        expect(answer === 0, `${JSON.stringify(left)} vs ${JSON.stringify(right)}`).toBe(same);
      }
    }
  });

  it('is antisymmetric', () => {
    for (const left of cards) {
      for (const right of cards) {
        // Summed rather than negated: `Math.sign` gives -0 for a zero, and -0 is not 0.
        expect(Math.sign(compareTodayCards(left, right)) + Math.sign(compareTodayCards(right, left))).toBe(0);
      }
    }
  });

  it('is transitive', () => {
    const next = randoms(20_260_920);
    const pick = (): TodayCardOrder => cards[Math.floor(next() * cards.length)] as TodayCardOrder;
    for (let attempt = 0; attempt < 3000; attempt += 1) {
      const a = pick();
      const b = pick();
      const c = pick();
      if (compareTodayCards(a, b) <= 0 && compareTodayCards(b, c) <= 0) {
        expect(compareTodayCards(a, c)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('sorts the same list identically however it was shuffled', () => {
    const next = randoms(7);
    const canonical = [...cards].sort(compareTodayCards);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const shuffled = [...cards];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        const held = shuffled[index] as TodayCardOrder;
        shuffled[index] = shuffled[swap] as TodayCardOrder;
        shuffled[swap] = held;
      }
      expect(shuffled.sort(compareTodayCards)).toEqual(canonical);
    }
  });
});

describe('a firm card aggregates its own items', () => {
  const items: readonly TodayItemOrder[] = [
    { itemKey: 'email:2', kind: 'email_due', dueAt: '2026-09-21T13:00:00.000Z' },
    { itemKey: 'callback:1', kind: 'callback', dueAt: '2026-09-21T16:00:00.000Z' },
    { itemKey: 'email:1', kind: 'email_due', dueAt: '2026-09-21T09:00:00.000Z' },
    { itemKey: 'call:1', kind: 'call_due', dueAt: '2026-09-21T10:00:00.000Z' },
  ];

  it('takes its lane and sort instant from the highest-priority, earliest-due item', () => {
    // The callback is later in the day than every email, and still decides the lane.
    expect(aggregateCard(items)).toEqual({
      lane: 'callback',
      sortAt: '2026-09-21T16:00:00.000Z',
      counts: { replies: 0, emailsDue: 2, callsDue: 1, open: 4 },
    });
  });

  it('orders the expanded tasks by lane precedence then due instant', () => {
    expect([...items].sort(compareTodayItems).map(item => item.itemKey)).toEqual([
      'callback:1',
      'email:1',
      'call:1',
      'email:2',
    ]);
  });

  it('has no lane at all when nothing is unfinished', () => {
    expect(aggregateCard([])).toBeNull();
  });
});
