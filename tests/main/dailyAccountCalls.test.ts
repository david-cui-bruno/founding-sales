import { describe, expect, it } from 'vitest';

import { isBusinessWindowOpen, morningEvidenceScore, orderMorningCalls, planDailyAccountCalls } from '../../src/main/domain/today/todayOrdering';
import { PLAYBOOK_CHANNEL_POLICIES_V2 } from '../../src/main/domain/cadence/cadenceScheduler';

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

  it('retains due work when configured new-call slots are zero', () => {
    expect(planDailyAccountCalls({
      due: ['warm-due'],
      ranked: ['new-cold'],
      newCallSlots: 0,
      completedAccountIds: [],
      totalCallCapacity: null,
    })).toEqual({ accountIds: ['warm-due'], workloadConflict: false });
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

describe('planDailyAccountCalls daily budget (D2, 17 Sep 2026)', () => {
  it('lets a new-firm call made today consume its slot instead of pulling the next firm forward', () => {
    const ranked = Array.from({ length: 40 }, (_, index) => `new-${String(index).padStart(2, '0')}`);
    const morning = planDailyAccountCalls({ due: ['due-a'], ranked, newCallSlots: 30, completedAccountIds: [], totalCallCapacity: null });
    expect(morning.accountIds).toHaveLength(31);
    const afterOne = planDailyAccountCalls({ due: ['due-a'], ranked, newCallSlots: 30, completedAccountIds: ['new-03'], totalCallCapacity: null });
    expect(afterOne.accountIds).toHaveLength(30);
    expect(afterOne.accountIds).not.toContain('new-03');
    expect(afterOne.accountIds.slice(1)).toEqual(ranked.filter(id => id !== 'new-03').slice(0, 29));
    // A due firm called today keeps its due place and consumes no new slot; a local call on a firm outside the list still counts once.
    const dueCalled = planDailyAccountCalls({ due: ['due-a'], ranked, newCallSlots: 30, completedAccountIds: ['due-a'], totalCallCapacity: null });
    expect(dueCalled.accountIds).toHaveLength(31);
    const elsewhere = planDailyAccountCalls({ due: [], ranked, newCallSlots: 30, completedAccountIds: ['unlisted-firm', 'unlisted-firm'], totalCallCapacity: null });
    expect(elsewhere.accountIds).toHaveLength(29);
    expect(planDailyAccountCalls({ due: [], ranked, newCallSlots: 2, completedAccountIds: ['x', 'y', 'z'], totalCallCapacity: null }).accountIds).toEqual([]);
  });
});

describe('orderMorningCalls', () => {
  it('orders by open local window, then evidence richness, then name, then account id, and drops duplicates', () => {
    expect(orderMorningCalls([
      { accountId: 'closed-rich', windowOpen: false, evidenceScore: 3, name: 'Aardvark' },
      { accountId: 'open-thin-z', windowOpen: true, evidenceScore: 0, name: 'Zebra' },
      { accountId: 'unknown-rich', windowOpen: null, evidenceScore: 3, name: 'Middle' },
      { accountId: 'open-rich-b', windowOpen: true, evidenceScore: 2, name: 'Bravo' },
      { accountId: 'open-rich-a2', windowOpen: true, evidenceScore: 2, name: 'Alpha' },
      { accountId: 'open-rich-a1', windowOpen: true, evidenceScore: 2, name: 'Alpha' },
      { accountId: 'open-rich-b', windowOpen: true, evidenceScore: 2, name: 'Bravo' },
    ])).toEqual(['open-rich-a1', 'open-rich-a2', 'open-rich-b', 'open-thin-z', 'unknown-rich', 'closed-rich']);
    expect(orderMorningCalls([])).toEqual([]);
    expect(() => orderMorningCalls([{ accountId: 'x', windowOpen: true, evidenceScore: Number.NaN, name: 'x' }])).toThrow('evidenceScore');
  });

  it('scores evidence richness from the portfolio count, the residential scope fact and the operating footprint fact', () => {
    const claim = (key: 'residential_scope' | 'operating_footprint' | 'pain', kind: 'fact' | 'hypothesis' = 'fact') => ({ kind, key, value: 'x', evidenceIds: ['e'] });
    const portfolio = [{ count: 12, measure: 'units' as const, scope: 'managed' as const, evidenceIds: ['e'] }];
    expect(morningEvidenceScore({ claims: [], portfolio: [] })).toBe(0);
    expect(morningEvidenceScore({ claims: [claim('residential_scope')], portfolio: [] })).toBe(1);
    expect(morningEvidenceScore({ claims: [claim('residential_scope'), claim('operating_footprint')], portfolio })).toBe(3);
    // Hypotheses and other facts do not count, and a repeated fact counts once.
    expect(morningEvidenceScore({ claims: [claim('residential_scope', 'hypothesis'), claim('pain'), claim('operating_footprint'), claim('operating_footprint')], portfolio: [] })).toBe(1);
  });

  it('decides the local business window from the v2 call windows in the firm zone, and answers null for an unknown zone', () => {
    const windows = PLAYBOOK_CHANNEL_POLICIES_V2.call.windows;
    // Monday 2026-08-31.
    expect(isBusinessWindowOpen({ generatedAt: '2026-08-31T13:00:00.000Z', timezone: 'America/New_York', windows })).toBe(true); // 09:00 EDT
    expect(isBusinessWindowOpen({ generatedAt: '2026-08-31T12:59:59.000Z', timezone: 'America/New_York', windows })).toBe(false); // 08:59 EDT
    expect(isBusinessWindowOpen({ generatedAt: '2026-08-31T16:30:00.000Z', timezone: 'America/New_York', windows })).toBe(false); // 12:30 EDT, lunch
    expect(isBusinessWindowOpen({ generatedAt: '2026-08-31T16:30:00.000Z', timezone: 'America/Chicago', windows })).toBe(true); // 11:30 CDT
    expect(isBusinessWindowOpen({ generatedAt: '2026-08-31T16:30:00.000Z', timezone: 'America/Los_Angeles', windows })).toBe(true); // 09:30 PDT
    expect(isBusinessWindowOpen({ generatedAt: '2026-08-31T15:00:00.000Z', timezone: 'America/Los_Angeles', windows })).toBe(false); // 08:00 PDT
    // Saturday 2026-09-05 at 10:00 EDT is closed under v2 (weekdays only).
    expect(isBusinessWindowOpen({ generatedAt: '2026-09-05T14:00:00.000Z', timezone: 'America/New_York', windows })).toBe(false);
    expect(isBusinessWindowOpen({ generatedAt: '2026-08-31T15:00:00.000Z', timezone: 'Not/AZone', windows })).toBeNull();
    expect(() => isBusinessWindowOpen({ generatedAt: 'yesterday', timezone: 'America/New_York', windows })).toThrow();
  });
});
