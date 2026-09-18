import { describe, expect, it } from 'vitest';
import { planDailyAccountCalls } from '../../src/main/domain/today/todayOrdering';

/**
 * Lane 32 writes a first draft for every inbound reply but could not touch
 * `src/main/domain/today/`, so Today never led with the firm that answered.
 * A reply outranks a promised callback, a due sequence step and a new firm.
 */
describe('a firm that replied leads the morning list', () => {
  it('puts reply firms first, then callbacks, then due steps, then new firms', () => {
    expect(planDailyAccountCalls({
      replies: ['reply-firm'],
      callbacks: ['callback-firm'],
      due: ['due-firm'],
      ranked: ['new-firm', 'reply-firm', 'callback-firm', 'due-firm'],
      newCallSlots: 30,
      completedAccountIds: [],
      totalCallCapacity: null,
    }).accountIds).toEqual(['reply-firm', 'callback-firm', 'due-firm', 'new-firm']);
  });

  it('never lists a reply firm twice and never lets it consume a new-firm slot', () => {
    const plan = planDailyAccountCalls({
      replies: ['reply-firm', 'reply-firm'],
      callbacks: ['reply-firm'],
      due: ['reply-firm'],
      ranked: ['reply-firm', 'new-one', 'new-two'],
      newCallSlots: 2,
      completedAccountIds: ['reply-firm'],
      totalCallCapacity: null,
    });
    expect(plan.accountIds).toEqual(['reply-firm', 'new-one', 'new-two']);
  });

  it('keeps the existing order exactly when no firm has replied', () => {
    expect(planDailyAccountCalls({
      callbacks: ['callback-firm'],
      due: ['due-firm'],
      ranked: ['new-firm'],
      newCallSlots: 1,
      completedAccountIds: [],
      totalCallCapacity: null,
    }).accountIds).toEqual(['callback-firm', 'due-firm', 'new-firm']);
  });
});
