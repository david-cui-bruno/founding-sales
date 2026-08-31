import { describe, expect, it } from 'vitest';

import {
  classifyTodayCandidate,
  compareTodayItems,
  planTodayQueue,
  resolveLocalDayInterval,
} from '../../src/main/domain/today/todayOrdering';
import { DEFAULT_TODAY_CAPACITY } from '../../src/main/domain/today/todayTypes';
import type {
  ParsedTodayCandidate,
  TodayEvaluationContext,
  TodayItem,
} from '../../src/main/domain/today/todayTypes';
import type {
  EffectivePrioritySnapshot,
} from '../../src/main/domain/prioritization/prioritizationTypes';
import { PrioritizationInputCorruptionError } from '../../src/main/domain/support/domainErrors';

// Fixed instants inside a founder-local New York day.
const GENERATED_AT = '2026-08-31T16:00:00.000Z'; // 12:00 local (EDT)
const DAY = resolveLocalDayInterval({ generatedAt: GENERATED_AT, timezone: 'America/New_York' });
const CONTEXT: TodayEvaluationContext = {
  generatedAt: GENERATED_AT,
  timezone: 'America/New_York',
  localDayStartAt: DAY.localDayStartAt,
  localDayEndAt: DAY.localDayEndAt,
  capacity: DEFAULT_TODAY_CAPACITY,
};

function prioritySnapshot(
  overrides: Partial<{
    effectivePriority: 'p0' | 'p1' | 'p2' | 'p3';
    lastContactActivityId: string | null;
    lastContactAt: string | null;
    snooze: boolean;
    dismiss: boolean;
    pin: boolean;
    timingMilliPoints: number;
    fitPoints: number;
    prospectId: string;
  }> = {},
): EffectivePrioritySnapshot {
  const control = (kind: 'pin_to_top' | 'snooze' | 'dismiss') => Object.freeze({
    id: `${kind}-control`,
    kind,
    priority: null,
    reason: 'Founder control',
    createdAt: '2026-08-31T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    status: 'active' as const,
  });
  return Object.freeze({
    prospectId: overrides.prospectId ?? 'prospect-1',
    ruleVersionId: 'founder-priority-v1',
    evaluationId: 'evaluation-1',
    projectionVersion: 1,
    evaluatedAt: '2026-08-31T12:00:00.000Z',
    asOf: GENERATED_AT,
    computedPriority: overrides.effectivePriority ?? 'p1',
    effectivePriority: overrides.effectivePriority ?? 'p1',
    computedPlay: 'contact_today',
    fitPoints: overrides.fitPoints ?? 15,
    fitBand: 'medium',
    timingMilliPoints: overrides.timingMilliPoints ?? 12_000,
    timingBand: 'warm',
    reachability: 'direct',
    dataConfidence: 7,
    earliestTriggerExpiresAt: null,
    verifyFirst: false,
    lastContactActivityId: overrides.lastContactActivityId ?? null,
    lastContactAt: overrides.lastContactAt ?? null,
    controls: Object.freeze({
      priority: null,
      pin: overrides.pin ? control('pin_to_top') : null,
      snooze: overrides.snooze ? control('snooze') : null,
      dismiss: overrides.dismiss ? control('dismiss') : null,
    }),
    explanation: Object.freeze([]),
  }) as EffectivePrioritySnapshot;
}

let candidateCounter = 0;

function candidate(
  overrides: Omit<Partial<ParsedTodayCandidate>, 'action'> & {
    action?: Partial<ParsedTodayCandidate['action']>;
  } = {},
): ParsedTodayCandidate {
  candidateCounter += 1;
  const suffix = String(candidateCounter).padStart(3, '0');
  const { action: actionOverrides, ...candidateOverrides } = overrides;
  return {
    cycleId: `cycle-${suffix}`,
    personId: `person-${suffix}`,
    prospectId: `prospect-${suffix}`,
    stage: 'ready',
    workflowStatus: 'active',
    action: {
      id: `action-${suffix}`,
      workIntent: 'discretionary_prospecting',
      actionType: 'call',
      channel: 'phone',
      dueAt: GENERATED_AT,
      timezone: 'America/New_York',
      allowedWindow: null,
      inboundSla: { kind: 'none', dueAt: null, sourceEventId: null, provenance: null },
      ...actionOverrides,
    },
    cadence: null,
    priority: prioritySnapshot(),
    priorityState: 'current',
    selectedTriggerReasons: [],
    verifyFirst: false,
    lastActivity: null,
    stageEnteredAt: '2026-08-30T12:00:00.000Z',
    inlineDiagnostics: [],
    ...candidateOverrides,
  };
}

describe('resolveLocalDayInterval', () => {
  it('computes the DST-safe founder-local half-open day', () => {
    expect(DAY.localDate).toBe('2026-08-31');
    expect(DAY.localDayStartAt).toBe('2026-08-31T04:00:00.000Z'); // EDT midnight
    expect(DAY.localDayEndAt).toBe('2026-09-01T04:00:00.000Z');
  });

  it('handles fall-back and spring-forward days', () => {
    // 2026-11-01 is the US fall-back date: the local day is 25 hours long.
    const fallBack = resolveLocalDayInterval({
      generatedAt: '2026-11-01T12:00:00.000Z', timezone: 'America/New_York',
    });
    expect(fallBack.localDate).toBe('2026-11-01');
    expect(fallBack.localDayStartAt).toBe('2026-11-01T04:00:00.000Z'); // EDT midnight
    expect(fallBack.localDayEndAt).toBe('2026-11-02T05:00:00.000Z'); // EST midnight
    // 2026-03-08 is the US spring-forward date: 23 hours long.
    const springForward = resolveLocalDayInterval({
      generatedAt: '2026-03-08T12:00:00.000Z', timezone: 'America/New_York',
    });
    expect(springForward.localDayStartAt).toBe('2026-03-08T05:00:00.000Z'); // EST midnight
    expect(springForward.localDayEndAt).toBe('2026-03-09T04:00:00.000Z'); // EDT midnight
  });

  it('rejects invalid zones and noncanonical instants', () => {
    expect(() => resolveLocalDayInterval({
      generatedAt: GENERATED_AT, timezone: 'Not/AZone',
    })).toThrow(PrioritizationInputCorruptionError);
    expect(() => resolveLocalDayInterval({
      generatedAt: '2026-08-31T16:00:00Z', timezone: 'America/New_York',
    })).toThrow(PrioritizationInputCorruptionError);
  });
});

describe('classifyTodayCandidate first-match order', () => {
  it('puts onboarding first even when overdue, suppressed, and unprioritized', () => {
    const row = candidate({
      workflowStatus: 'onboarding',
      stage: 'won',
      priority: prioritySnapshot({ snooze: true }),
      priorityState: 'missing',
      action: { workIntent: 'promised_follow_up', dueAt: '2026-08-01T00:00:00.000Z' },
    });
    const disposition = classifyTodayCandidate(row, CONTEXT);
    expect(disposition).toMatchObject({ kind: 'lane', lane: 'won_onboarding' });
  });

  it('keeps fresh inbound inside its SLA ahead of overdue timing', () => {
    const inbound = candidate({
      action: {
        workIntent: 'inbound_response',
        dueAt: '2026-08-31T10:00:00.000Z',
        inboundSla: {
          kind: 'inbound_demo_permitted_minutes',
          dueAt: '2026-08-31T17:00:00.000Z',
          sourceEventId: 'source-1',
          provenance: {
            version: 1,
            sourceEventId: 'source-1',
            sourceObservedAt: '2026-08-31T09:00:00.000Z',
            calculation: 'permitted_minutes',
            minutes: 15,
            policyId: 'founder_call_v1',
            computedDueAt: '2026-08-31T17:00:00.000Z',
          },
        },
      },
    });
    expect(classifyTodayCandidate(inbound, CONTEXT))
      .toMatchObject({ kind: 'lane', lane: 'inbound_interrupt' });
  });

  it('enters Overdue at exactly the inbound SLA deadline', () => {
    const breached = candidate({
      action: {
        workIntent: 'inbound_response',
        dueAt: '2026-08-31T10:00:00.000Z',
        inboundSla: {
          kind: 'direct_referral_elapsed',
          dueAt: GENERATED_AT,
          sourceEventId: 'source-2',
          provenance: {
            version: 1,
            sourceEventId: 'source-2',
            sourceObservedAt: '2026-08-29T16:00:00.000Z',
            calculation: 'elapsed_hours',
            hours: 48,
            policyId: null,
            computedDueAt: GENERATED_AT,
          },
        },
      },
    });
    expect(classifyTodayCandidate(breached, CONTEXT)).toMatchObject({
      kind: 'lane', lane: 'overdue',
      item: { laneReason: 'inbound_sla_breached' },
    });
  });

  it('treats equality as due now, not overdue, for non-discretionary work', () => {
    const dueNow = candidate({
      action: { workIntent: 'promised_follow_up', dueAt: GENERATED_AT },
    });
    expect(classifyTodayCandidate(dueNow, CONTEXT))
      .toMatchObject({ kind: 'lane', lane: 'due_primary' });
    const overdue = candidate({
      action: { workIntent: 'promised_follow_up', dueAt: '2026-08-31T15:59:59.999Z' },
    });
    expect(classifyTodayCandidate(overdue, CONTEXT))
      .toMatchObject({ kind: 'lane', lane: 'overdue', item: { laneReason: 'non_discretionary_overdue' } });
  });

  it('routes promised follow-ups at Interviewed/Offered due today into post_interview_offer', () => {
    for (const stage of ['interviewed', 'offered'] as const) {
      const promised = candidate({
        stage,
        action: { workIntent: 'promised_follow_up', dueAt: '2026-08-31T20:00:00.000Z' },
      });
      expect(classifyTodayCandidate(promised, CONTEXT))
        .toMatchObject({ kind: 'lane', lane: 'post_interview_offer' });
    }
  });

  it('keeps Unreviewed internal review actionable without cadence or projection', () => {
    const review = candidate({
      stage: 'unreviewed',
      priority: null,
      priorityState: 'missing',
      action: {
        workIntent: 'internal_review',
        actionType: 'review_prospect',
        channel: null,
        dueAt: '2026-08-31T20:00:00.000Z',
      },
    });
    expect(classifyTodayCandidate(review, CONTEXT))
      .toMatchObject({ kind: 'lane', lane: 'due_primary' });
  });

  it('keeps a Day-0 discretionary Ready call in priority lanes despite being due now', () => {
    const dayZero = candidate({
      priority: prioritySnapshot({ effectivePriority: 'p0' }),
      action: { dueAt: '2026-08-31T10:00:00.000Z' },
    });
    expect(classifyTodayCandidate(dayZero, CONTEXT))
      .toMatchObject({ kind: 'lane', lane: 'new_p0', item: { laneReason: 'ready_p0' } });
    const p1 = candidate({
      priority: prioritySnapshot({ effectivePriority: 'p1' }),
      action: { dueAt: '2026-08-31T10:00:00.000Z' },
    });
    expect(classifyTodayCandidate(p1, CONTEXT))
      .toMatchObject({ kind: 'lane', lane: 'p1' });
    for (const priority of ['p2', 'p3'] as const) {
      const exploration = candidate({
        priority: prioritySnapshot({ effectivePriority: priority }),
      });
      expect(classifyTodayCandidate(exploration, CONTEXT))
        .toMatchObject({ kind: 'lane', lane: 'exploration' });
    }
  });

  it('defers future promises to Later while retaining lane provenance', () => {
    const future = candidate({
      action: { workIntent: 'promised_follow_up', dueAt: '2026-09-05T12:00:00.000Z' },
    });
    const disposition = classifyTodayCandidate(future, CONTEXT);
    expect(disposition).toMatchObject({
      kind: 'later',
      item: { lane: 'later', deferredFrom: 'due_primary', laneReason: 'future_promise' },
    });
  });

  it('suppresses only discretionary lanes via snooze/dismiss/resurfacing', () => {
    const snoozed = candidate({ priority: prioritySnapshot({ snooze: true }) });
    expect(classifyTodayCandidate(snoozed, CONTEXT))
      .toMatchObject({ kind: 'suppressed', reason: 'snoozed' });
    const dismissed = candidate({ priority: prioritySnapshot({ dismiss: true }) });
    expect(classifyTodayCandidate(dismissed, CONTEXT))
      .toMatchObject({ kind: 'suppressed', reason: 'dismissed' });
    // Recently contacted inside the resurfacing window.
    const recent = candidate({
      priority: prioritySnapshot({
        lastContactActivityId: 'activity-recent',
        lastContactAt: '2026-08-30T16:00:00.000Z',
      }),
    });
    expect(classifyTodayCandidate(recent, CONTEXT))
      .toMatchObject({ kind: 'suppressed', reason: 'recently_contacted' });
    // At the exact end of the interval the row may reappear.
    const boundary = candidate({
      priority: prioritySnapshot({
        lastContactActivityId: 'activity-boundary',
        lastContactAt: '2026-08-28T16:00:00.000Z', // exactly 259200s before
      }),
    });
    expect(classifyTodayCandidate(boundary, CONTEXT).kind).toBe('lane');
    // Promise lanes are never suppressed.
    const promisedSnoozed = candidate({
      priority: prioritySnapshot({ snooze: true }),
      action: { workIntent: 'promised_follow_up', dueAt: '2026-08-31T20:00:00.000Z' },
    });
    expect(classifyTodayCandidate(promisedSnoozed, CONTEXT))
      .toMatchObject({ kind: 'lane', lane: 'due_primary' });
  });

  it('flags torn or future last-contact snapshots as diagnostics', () => {
    const torn = candidate({
      priority: prioritySnapshot({
        lastContactActivityId: null,
        lastContactAt: '2026-08-30T16:00:00.000Z',
      }),
    });
    expect(classifyTodayCandidate(torn, CONTEXT))
      .toMatchObject({ kind: 'diagnostic', diagnostic: { kind: 'invalid_last_contact' } });
    const future = candidate({
      priority: prioritySnapshot({
        lastContactActivityId: 'activity-future',
        lastContactAt: '2026-09-05T00:00:00.000Z',
      }),
    });
    expect(classifyTodayCandidate(future, CONTEXT))
      .toMatchObject({ kind: 'diagnostic', diagnostic: { kind: 'invalid_last_contact' } });
  });

  it('turns discretionary rows without a current projection into typed diagnostics', () => {
    for (const [state, kind] of [
      ['missing', 'missing_priority_projection'],
      ['stale', 'stale_priority_projection'],
      ['corrupt', 'corrupt_priority_projection'],
    ] as const) {
      const row = candidate({ priority: null, priorityState: state });
      expect(classifyTodayCandidate(row, CONTEXT))
        .toMatchObject({ kind: 'diagnostic', diagnostic: { kind } });
    }
  });
});

describe('compareTodayItems', () => {
  function laneItem(overrides: Omit<Partial<TodayItem>, 'action'> & {
    action?: Partial<TodayItem['action']>;
  }): TodayItem {
    const base = candidate({});
    const { action: actionOverrides, ...itemOverrides } = overrides;
    return {
      cycleId: base.cycleId,
      personId: base.personId,
      prospectId: base.prospectId,
      lane: 'due_primary',
      deferredFrom: null,
      laneReason: 'other_non_discretionary_due_today',
      action: { ...base.action, ...actionOverrides },
      cadence: null,
      priority: base.priority,
      selectedTriggerReasons: [],
      verifyFirst: false,
      pinned: false,
      lastActivity: null,
      stageEnteredAt: base.stageEnteredAt,
      inlineDiagnostics: [],
      ...itemOverrides,
    };
  }

  it('orders due lanes by pin, due, stage age, step sequence, action ID, cycle ID', () => {
    const pinnedLate = laneItem({
      cycleId: 'cycle-z', pinned: true, action: { dueAt: '2026-08-31T19:00:00.000Z' },
    });
    const earlier = laneItem({
      cycleId: 'cycle-a', action: { dueAt: '2026-08-31T17:00:00.000Z' },
    });
    expect(compareTodayItems(pinnedLate, earlier)).toBeLessThan(0);
    const olderStage = laneItem({
      cycleId: 'cycle-b',
      stageEnteredAt: '2026-08-01T00:00:00.000Z',
      action: { dueAt: '2026-08-31T17:00:00.000Z' },
    });
    expect(compareTodayItems(olderStage, earlier)).toBeLessThan(0);
    const withStep = laneItem({
      cycleId: 'cycle-c',
      cadence: {
        enrollmentId: 'e', definitionId: 'd', family: 'cadence_a', stepId: 's',
        stepSequence: 0, componentId: 'c',
      },
      action: { dueAt: '2026-08-31T17:00:00.000Z' },
    });
    const withoutStep = laneItem({
      cycleId: 'cycle-d', action: { dueAt: '2026-08-31T17:00:00.000Z' },
    });
    expect(compareTodayItems(withStep, withoutStep)).toBeLessThan(0);
  });

  it('orders exploration with P2 always before P3, even a pinned P3', () => {
    const p2 = laneItem({
      lane: 'exploration',
      laneReason: 'ready_p2',
      priority: prioritySnapshot({ effectivePriority: 'p2', prospectId: 'prospect-p2' }),
    });
    const pinnedP3 = laneItem({
      lane: 'exploration',
      laneReason: 'ready_p3',
      pinned: true,
      priority: prioritySnapshot({ effectivePriority: 'p3', prospectId: 'prospect-p3' }),
    });
    expect(compareTodayItems(p2, pinnedP3)).toBeLessThan(0);
  });

  it('orders P0/P1 lanes by pin then the exact Task 11 tuple', () => {
    const strongTiming = laneItem({
      lane: 'p1',
      laneReason: 'ready_p1',
      priority: prioritySnapshot({
        effectivePriority: 'p1', timingMilliPoints: 30_000, prospectId: 'prospect-strong',
      }),
    });
    const weakTimingPinned = laneItem({
      lane: 'p1',
      laneReason: 'ready_p1',
      pinned: true,
      priority: prioritySnapshot({
        effectivePriority: 'p1', timingMilliPoints: 1_000, prospectId: 'prospect-weak',
      }),
    });
    // Pin wins within the lane.
    expect(compareTodayItems(weakTimingPinned, strongTiming)).toBeLessThan(0);
    const unpinnedWeak = { ...weakTimingPinned, pinned: false };
    expect(compareTodayItems(strongTiming, unpinnedWeak)).toBeLessThan(0);
  });
});

describe('planTodayQueue capacity', () => {
  function buildQueue(input: {
    candidates: ParsedTodayCandidate[];
    completed?: number;
    dialBudget?: number;
    explorationSlots?: number;
  }) {
    return planTodayQueue({
      candidates: input.candidates,
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: {
        ...DEFAULT_TODAY_CAPACITY,
        dialBudget: input.dialBudget ?? DEFAULT_TODAY_CAPACITY.dialBudget,
        explorationSlots: input.explorationSlots ?? DEFAULT_TODAY_CAPACITY.explorationSlots,
      },
      completedDiscretionaryDialCount: input.completed ?? 0,
    });
  }

  function laneOf(queue: ReturnType<typeof buildQueue>, lane: string) {
    return queue.lanes.find((entry) => entry.lane === lane)!.items;
  }

  it('applies the exact capacity algorithm with exploration reservation', () => {
    const p0Calls = Array.from({ length: 3 }, () => candidate({
      priority: prioritySnapshot({ effectivePriority: 'p0' }),
    }));
    const p1Calls = Array.from({ length: 3 }, () => candidate({
      priority: prioritySnapshot({ effectivePriority: 'p1' }),
    }));
    const p2Call = candidate({ priority: prioritySnapshot({ effectivePriority: 'p2' }) });
    const p3Call = candidate({ priority: prioritySnapshot({ effectivePriority: 'p3' }) });
    const p3Extra = candidate({ priority: prioritySnapshot({ effectivePriority: 'p3' }) });
    const queue = buildQueue({
      candidates: [...p0Calls, ...p1Calls, p2Call, p3Call, p3Extra],
      dialBudget: 5,
    });
    // remaining=5; exploration selects p2+p3 (2 slots) consuming 2; p0 takes 3;
    // p1 overflows entirely; p3Extra is quota overflow.
    expect(laneOf(queue, 'exploration')).toHaveLength(2);
    expect(laneOf(queue, 'new_p0')).toHaveLength(3);
    expect(laneOf(queue, 'p1')).toHaveLength(0);
    const later = laneOf(queue, 'later');
    expect(later.filter((item) => item.laneReason === 'capacity_overflow')).toHaveLength(3);
    expect(later.filter((item) => item.laneReason === 'exploration_quota_overflow')).toHaveLength(1);
    expect(queue.queuedDiscretionaryDialCount).toBe(5);
    expect(queue.remainingDiscretionaryDialCount).toBe(0);
  });

  it('never truncates promise/onboarding/inbound calls and keeps them out of dial counters', () => {
    const promises = Array.from({ length: 45 }, () => candidate({
      action: { workIntent: 'promised_follow_up', dueAt: '2026-08-31T20:00:00.000Z' },
    }));
    const queue = buildQueue({ candidates: promises, dialBudget: 1 });
    expect(laneOf(queue, 'due_primary')).toHaveLength(45);
    expect(queue.queuedDiscretionaryDialCount).toBe(0);
    expect(queue.remainingDiscretionaryDialCount).toBe(1);
  });

  it('exempts discretionary non-call work from the dial budget', () => {
    const texts = Array.from({ length: 4 }, () => candidate({
      priority: prioritySnapshot({ effectivePriority: 'p1' }),
      action: { actionType: 'text', channel: 'text' },
    }));
    const queue = buildQueue({ candidates: texts, dialBudget: 0 });
    expect(laneOf(queue, 'p1')).toHaveLength(4);
    expect(queue.queuedDiscretionaryDialCount).toBe(0);
  });

  it('honours completed counts at and above budget', () => {
    const calls = [
      candidate({ priority: prioritySnapshot({ effectivePriority: 'p0' }) }),
      candidate({ priority: prioritySnapshot({ effectivePriority: 'p1' }) }),
    ];
    const atBudget = buildQueue({ candidates: calls, dialBudget: 40, completed: 40 });
    expect(laneOf(atBudget, 'new_p0')).toHaveLength(0);
    expect(laneOf(atBudget, 'p1')).toHaveLength(0);
    expect(laneOf(atBudget, 'later')).toHaveLength(2);
    expect(atBudget.remainingDiscretionaryDialCount).toBe(0);
    const overBudget = buildQueue({ candidates: calls, dialBudget: 40, completed: 45 });
    expect(overBudget.remainingDiscretionaryDialCount).toBe(0);
    expect(overBudget.dialCount).toBe(45);
  });

  it('keeps mixed exploration: non-calls free, calls consume remaining, P2 first', () => {
    const p2Text = candidate({
      priority: prioritySnapshot({ effectivePriority: 'p2' }),
      action: { actionType: 'text', channel: 'text' },
    });
    const p3Call = candidate({ priority: prioritySnapshot({ effectivePriority: 'p3' }) });
    const queue = buildQueue({ candidates: [p3Call, p2Text], dialBudget: 0 });
    const exploration = laneOf(queue, 'exploration');
    // The text is retained without budget; the call overflows.
    expect(exploration).toHaveLength(1);
    expect(exploration[0]!.action.actionType).toBe('text');
    expect(laneOf(queue, 'later')).toHaveLength(1);
    expect(laneOf(queue, 'later')[0]!.laneReason).toBe('capacity_overflow');
  });

  it('accounts every candidate exactly once across lanes, later, suppressed, diagnostics', () => {
    const rows = [
      candidate({ workflowStatus: 'onboarding', stage: 'won', action: { workIntent: 'promised_follow_up' } }),
      candidate({ priority: prioritySnapshot({ effectivePriority: 'p0' }) }),
      candidate({ priority: prioritySnapshot({ snooze: true }) }),
      candidate({ priority: null, priorityState: 'missing' }),
      candidate({ action: { workIntent: 'promised_follow_up', dueAt: '2026-09-10T00:00:00.000Z' } }),
    ];
    const queue = planTodayQueue({
      candidates: rows,
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: 0,
    });
    const laneCycleIds = queue.lanes.flatMap((entry) => entry.items.map((item) => item.cycleId));
    const suppressedIds = queue.suppressed.map((entry) => entry.cycleId);
    const diagnosticIds = queue.diagnostics
      .map((entry) => entry.cycleId)
      .filter((id): id is string => id !== null);
    const all = [...laneCycleIds, ...suppressedIds, ...diagnosticIds];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(rows.map((row) => row.cycleId)));
  });

  it('flags duplicate cycle candidates as diagnostics', () => {
    const row = candidate({});
    const queue = planTodayQueue({
      candidates: [row, { ...row }],
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: 0,
    });
    expect(queue.diagnostics).toContainEqual(expect.objectContaining({
      cycleId: row.cycleId, kind: 'duplicate_candidate',
    }));
  });

  it('is byte-deterministic and mutates no inputs', () => {
    const rows = [
      candidate({ priority: prioritySnapshot({ effectivePriority: 'p0' }) }),
      candidate({ priority: prioritySnapshot({ effectivePriority: 'p2' }) }),
    ];
    const frozen = JSON.stringify(rows);
    const first = planTodayQueue({
      candidates: rows,
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: 2,
    });
    const second = planTodayQueue({
      candidates: rows,
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: 2,
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(rows)).toBe(frozen);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.lanes)).toBe(true);
  });

  it('rejects malformed capacity and counts with typed errors', () => {
    expect(() => planTodayQueue({
      candidates: [],
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: { ...DEFAULT_TODAY_CAPACITY, dialBudget: -1 },
      completedDiscretionaryDialCount: 0,
    })).toThrow(PrioritizationInputCorruptionError);
    expect(() => planTodayQueue({
      candidates: [],
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: -1,
    })).toThrow(PrioritizationInputCorruptionError);
  });
});

describe('static hard bans', () => {
  it('keeps the Today planner free of ambient time, SQL, and blended scores', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const name of ['todayOrdering.ts', 'todayTypes.ts']) {
      const text = readFileSync(
        join(process.cwd(), 'src/main/domain/today', name), 'utf8',
      ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(/Date\.now\s*\(/.test(text), `${name} uses Date.now`).toBe(false);
      expect(/Math\.random/.test(text), `${name} uses Math.random`).toBe(false);
      expect(/from '.*\/db\/database'/.test(text), `${name} imports the database`).toBe(false);
      expect(/\bscore\b/i.test(text), `${name} declares a score`).toBe(false);
      expect(/LIMIT\s+\d/i.test(text), `${name} applies an early SQL limit`).toBe(false);
    }
  });
});
