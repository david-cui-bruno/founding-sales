import { describe, expect, it } from 'vitest';

import { planDailyAccountCalls } from '../../src/main/domain/today/todayOrdering';

describe('planDailyAccountCalls', () => {
  it('retains due warm obligations plus eligible daily new account calls', () => {
    expect(planDailyAccountCalls({
      due: ['warm'],
      ranked: ['cold', 'warm'],
      newCallSlots: 1,
      completedAccountIds: [],
      totalCallCapacity: null,
    })).toEqual({ accountIds: ['warm', 'cold'], workloadConflict: false });
  });

  it('deduplicates due and ranked rows and does not spend slots on accounts already actually completed', () => {
    expect(planDailyAccountCalls({
      due: ['warm', 'warm'],
      ranked: ['done-cold', 'fresh-cold', 'fresh-cold', 'warm'],
      newCallSlots: 2,
      completedAccountIds: ['done-cold'],
      totalCallCapacity: 3,
    })).toEqual({ accountIds: ['warm', 'fresh-cold'], workloadConflict: false });
  });

  it('keeps due and new work visible while reporting explicit total-capacity conflicts', () => {
    expect(planDailyAccountCalls({
      due: ['warm-a', 'warm-b'],
      ranked: ['cold-a'],
      newCallSlots: 1,
      completedAccountIds: [],
      totalCallCapacity: 2,
    })).toEqual({ accountIds: ['warm-a', 'warm-b', 'cold-a'], workloadConflict: true });
  });

  it('requires explicit nullable capacity and nonnegative new-call slots', () => {
    expect(() => planDailyAccountCalls({
      due: [], ranked: ['cold'], newCallSlots: -1, completedAccountIds: [], totalCallCapacity: null,
    })).toThrow('newCallSlots');
    expect(() => planDailyAccountCalls({
      due: [], ranked: ['cold'], newCallSlots: 1, completedAccountIds: [], totalCallCapacity: undefined as unknown as null,
    })).toThrow('totalCallCapacity');
  });
});
