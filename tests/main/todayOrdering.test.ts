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
    cloudTiming: number | null;
    cloudSourcePercentile: number | null;
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
    cloudTiming: overrides.cloudTiming ?? null,
    cloudFit: null,
    cloudSourcePercentile: overrides.cloudSourcePercentile ?? null,
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
    resurfaceAt: null,
    resurfaceReason: null,
    inlineDiagnostics: [],
    ...candidateOverrides,
  };
}

describe('resolveLocalDayInterval', () => {
  it('computes the DST-safe founder-local half-open day', () => {
    expect(DAY.localDate).toBe('2026-08-31');
    expect(DAY.localDayStartAt).toBe('2026-08-31T04:00:00.000Z');
    expect(DAY.localDayEndAt).toBe('2026-09-01T04:00:00.000Z');
  });

  it('handles fall-back and spring-forward days', () => {
    const fallBack = resolveLocalDayInterval({
      generatedAt: '2026-11-01T15:00:00.000Z',
      timezone: 'America/New_York',
    });
    expect(fallBack.localDayStartAt).toBe('2026-11-01T04:00:00.000Z');
    expect(fallBack.localDayEndAt).toBe('2026-11-02T05:00:00.000Z');

    const springForward = resolveLocalDayInterval({
      generatedAt: '2026-03-08T15:00:00.000Z',
      timezone: 'America/New_York',
    });
    expect(springForward.localDayStartAt).toBe('2026-03-08T05:00:00.000Z');
    expect(springForward.localDayEndAt).toBe('2026-03-09T04:00:00.000Z');
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
  it('puts onboarding first regardless of intent or priority state', () => {
    const disposition = classifyTodayCandidate(candidate({
      stage: 'won',
      workflowStatus: 'onboarding',
      priority: null,
      priorityState: 'missing',
      action: { workIntent: 'promised_follow_up' },
    }), CONTEXT);
    expect(disposition).toMatchObject({
      kind: 'lane', lane: 'won_onboarding',
      item: { laneReason: 'won_onboarding' },
    });
  });

  it('hides a cycle with a future founder resurface marker', () => {
    const disposition = classifyTodayCandidate(candidate({
      resurfaceAt: '2026-09-02T16:00:00.000Z',
      resurfaceReason: 'snooze',
    }), CONTEXT);
    expect(disposition).toMatchObject({
      kind: 'suppressed', reason: 'resurface_scheduled',
    });
  });

  it('re-enters a due snooze with the Snoozed-until-today reason', () => {
    const disposition = classifyTodayCandidate(candidate({
      resurfaceAt: '2026-08-31T10:00:00.000Z',
      resurfaceReason: 'snooze',
      action: { workIntent: 'promised_follow_up' },
    }), CONTEXT);
    expect(disposition).toMatchObject({
      kind: 'lane', lane: 'due_primary',
      item: { laneReason: 'snoozed_until_today' },
    });
  });

  it('re-enters a due callback with the promised-callback reason', () => {
    const disposition = classifyTodayCandidate(candidate({
      resurfaceAt: GENERATED_AT,
      resurfaceReason: 'callback',
      commitment: { kind: 'callback', activityId: 'recorded-call', dueAt: GENERATED_AT },
      action: { workIntent: 'promised_follow_up' },
    }), CONTEXT);
    expect(disposition).toMatchObject({
      kind: 'lane', lane: 'due_primary',
      item: { laneReason: 'callback_promised_today' },
    });
  });

  it('keeps every inbound response in Fresh inbound, with or without SLA', () => {
    const insideSla = classifyTodayCandidate(candidate({
      action: {
        workIntent: 'inbound_response',
        inboundSla: {
          kind: 'inbound_demo_permitted_minutes',
          dueAt: '2026-08-31T16:10:00.000Z',
          sourceEventId: 'source-1',
          provenance: {
            version: 1,
            sourceEventId: 'source-1',
            sourceObservedAt: '2026-08-31T15:55:00.000Z',
            calculation: 'permitted_minutes',
            minutes: 15,
            policyId: 'founder_text_v1',
            computedDueAt: '2026-08-31T16:10:00.000Z',
          },
        },
      },
    }), CONTEXT);
    expect(insideSla).toMatchObject({
      kind: 'lane', lane: 'inbound_interrupt',
      item: { laneReason: 'inbound_inside_sla' },
    });

    const withoutSla = classifyTodayCandidate(candidate({
      action: { workIntent: 'inbound_response' },
    }), CONTEXT);
    expect(withoutSla).toMatchObject({ kind: 'lane', lane: 'inbound_interrupt' });
  });

  it('routes cadence-bound promises into Due cadence with a cadence reason', () => {
    const disposition = classifyTodayCandidate(candidate({
      action: { workIntent: 'promised_follow_up' },
      cadence: {
        enrollmentId: 'enrollment-1',
        definitionId: 'definition-1',
        family: 'post_offer',
        stepId: 'step-1',
        stepSequence: 0,
        componentId: 'component-1',
      },
    }), CONTEXT);
    expect(disposition).toMatchObject({
      kind: 'lane', lane: 'due_primary',
      item: { laneReason: 'cadence_step_next' },
    });
  });

  it('routes cadence-free promises and internal review into Due cadence', () => {
    expect(classifyTodayCandidate(candidate({
      action: { workIntent: 'promised_follow_up' },
    }), CONTEXT)).toMatchObject({
      kind: 'lane', lane: 'due_primary',
      item: { laneReason: 'cadence_step_next' },
    });
    expect(classifyTodayCandidate(candidate({
      stage: 'interviewed',
      action: { workIntent: 'internal_review', actionType: 'confirm_offer', channel: null },
    }), CONTEXT)).toMatchObject({
      kind: 'lane', lane: 'due_primary',
      item: { laneReason: 'promised_follow_up' },
    });
  });

  it('classifies discretionary work into priority lanes', () => {
    expect(classifyTodayCandidate(candidate({
      priority: prioritySnapshot({ effectivePriority: 'p0' }),
    }), CONTEXT)).toMatchObject({ kind: 'lane', lane: 'new_p0', item: { laneReason: 'ready_p0' } });
    expect(classifyTodayCandidate(candidate({
      priority: prioritySnapshot({ effectivePriority: 'p1' }),
    }), CONTEXT)).toMatchObject({ kind: 'lane', lane: 'p1', item: { laneReason: 'ready_p1' } });
    expect(classifyTodayCandidate(candidate({
      priority: prioritySnapshot({ effectivePriority: 'p2' }),
    }), CONTEXT)).toMatchObject({ kind: 'lane', lane: 'exploration', item: { laneReason: 'ready_p2' } });
    expect(classifyTodayCandidate(candidate({
      priority: prioritySnapshot({ effectivePriority: 'p3' }),
    }), CONTEXT)).toMatchObject({ kind: 'lane', lane: 'exploration', item: { laneReason: 'ready_p3' } });
  });

  it('suppresses only discretionary lanes via snooze/dismiss/resurfacing', () => {
    expect(classifyTodayCandidate(candidate({
      priority: prioritySnapshot({ snooze: true }),
    }), CONTEXT)).toMatchObject({ kind: 'suppressed', reason: 'snoozed' });
    expect(classifyTodayCandidate(candidate({
      priority: prioritySnapshot({ dismiss: true }),
    }), CONTEXT)).toMatchObject({ kind: 'suppressed', reason: 'dismissed' });
    expect(classifyTodayCandidate(candidate({
      priority: prioritySnapshot({
        lastContactActivityId: 'activity-1',
        lastContactAt: '2026-08-31T00:00:00.000Z',
      }),
    }), CONTEXT)).toMatchObject({ kind: 'suppressed', reason: 'recently_contacted' });
    // Promised work never suppresses on recency.
    expect(classifyTodayCandidate(candidate({
      priority: prioritySnapshot({
        lastContactActivityId: 'activity-1',
        lastContactAt: '2026-08-31T00:00:00.000Z',
      }),
      action: { workIntent: 'promised_follow_up' },
    }), CONTEXT)).toMatchObject({ kind: 'lane', lane: 'due_primary' });
  });

  it('flags torn or future last-contact snapshots as diagnostics', () => {
    expect(classifyTodayCandidate(candidate({
      priority: prioritySnapshot({
        lastContactActivityId: null,
        lastContactAt: '2026-08-31T00:00:00.000Z',
      }),
    }), CONTEXT)).toMatchObject({
      kind: 'diagnostic', diagnostic: { kind: 'invalid_last_contact' },
    });
    expect(classifyTodayCandidate(candidate({
      priority: prioritySnapshot({
        lastContactActivityId: 'activity-1',
        lastContactAt: '2026-09-01T00:00:00.000Z',
      }),
    }), CONTEXT)).toMatchObject({
      kind: 'diagnostic', diagnostic: { kind: 'invalid_last_contact' },
    });
  });

  it('turns discretionary rows without a current projection into typed diagnostics', () => {
    for (const [state, kind] of [
      ['missing', 'missing_priority_projection'],
      ['stale', 'stale_priority_projection'],
      ['corrupt', 'corrupt_priority_projection'],
    ] as const) {
      expect(classifyTodayCandidate(candidate({
        priority: null, priorityState: state,
      }), CONTEXT)).toMatchObject({ kind: 'diagnostic', diagnostic: { kind } });
    }
  });
});

function classifiedItem(
  input: ParsedTodayCandidate,
  context: TodayEvaluationContext = CONTEXT,
): TodayItem {
  const disposition = classifyTodayCandidate(input, context);
  if (disposition.kind !== 'lane' && disposition.kind !== 'later') {
    throw new Error(`Expected a lane disposition, got ${disposition.kind}`);
  }
  return disposition.item;
}

describe('compareTodayItems', () => {
  it('orders lanes by the fixed no-due-dates lane rank', () => {
    const onboarding = classifiedItem(candidate({
      stage: 'won', workflowStatus: 'onboarding',
      action: { workIntent: 'promised_follow_up' },
    }));
    const inbound = classifiedItem(candidate({
      action: { workIntent: 'inbound_response' },
    }));
    const dueCadence = classifiedItem(candidate({
      action: { workIntent: 'promised_follow_up' },
    }));
    const p0 = classifiedItem(candidate({
      priority: prioritySnapshot({ effectivePriority: 'p0' }),
    }));
    const sorted = [p0, dueCadence, inbound, onboarding].sort(compareTodayItems);
    expect(sorted.map(({ lane }) => lane)).toEqual([
      'won_onboarding', 'inbound_interrupt', 'due_primary', 'new_p0',
    ]);
  });

  it('orders within a lane by band, then cloud timing, then last-touch age', () => {
    const older = classifiedItem(candidate({
      priority: prioritySnapshot({ effectivePriority: 'p1' }),
      lastActivity: {
        id: 'activity-old', kind: 'call',
        occurredAt: '2026-08-20T00:00:00.000Z', observedOutcome: null,
      },
    }));
    const newer = classifiedItem(candidate({
      priority: prioritySnapshot({ effectivePriority: 'p1' }),
      lastActivity: {
        id: 'activity-new', kind: 'call',
        occurredAt: '2026-08-30T00:00:00.000Z', observedOutcome: null,
      },
    }));
    const cloudHot = classifiedItem(candidate({
      priority: prioritySnapshot({ effectivePriority: 'p1', cloudTiming: 90 }),
      lastActivity: {
        id: 'activity-mid', kind: 'call',
        occurredAt: '2026-08-25T00:00:00.000Z', observedOutcome: null,
      },
    }));
    const neverTouched = classifiedItem(candidate({
      priority: prioritySnapshot({ effectivePriority: 'p1' }),
    }));
    const sorted = [newer, older, cloudHot, neverTouched].sort(compareTodayItems);
    // Cloud timing outranks age; never-touched counts as oldest.
    expect(sorted.map(({ cycleId }) => cycleId)).toEqual([
      cloudHot.cycleId, neverTouched.cycleId, older.cycleId, newer.cycleId,
    ]);
  });

  it('orders within a lane by the within-source percentile before raw cloud timing', () => {
    // Raw timing favors the "violation" row, but the "parcel" row stands
    // higher within its own source: the percentile must win (F10).
    const parcelTop = classifiedItem(candidate({
      priority: prioritySnapshot({
        effectivePriority: 'p2', cloudSourcePercentile: 100, cloudTiming: 10,
      }),
    }));
    const violationMid = classifiedItem(candidate({
      priority: prioritySnapshot({
        effectivePriority: 'p2', cloudSourcePercentile: 50, cloudTiming: 95,
      }),
    }));
    const unscored = classifiedItem(candidate({
      priority: prioritySnapshot({ effectivePriority: 'p2' }),
    }));
    const sorted = [violationMid, unscored, parcelTop].sort(compareTodayItems);
    expect(sorted.map(({ cycleId }) => cycleId)).toEqual([
      parcelTop.cycleId, violationMid.cycleId, unscored.cycleId,
    ]);
  });

  it('fills the exploration lane using the within-source percentile, not raw scores', () => {
    // Two "sources": the high-raw-score source would monopolize both
    // exploration slots under raw ordering. Percentiles interleave them.
    const violationTop = candidate({
      priority: prioritySnapshot({
        effectivePriority: 'p2', cloudSourcePercentile: 100, cloudTiming: 90,
      }),
    });
    const violationMid = candidate({
      priority: prioritySnapshot({
        effectivePriority: 'p2', cloudSourcePercentile: 66, cloudTiming: 80,
      }),
    });
    const parcelTop = candidate({
      priority: prioritySnapshot({
        effectivePriority: 'p2', cloudSourcePercentile: 100, cloudTiming: 20,
      }),
    });
    const queue = planTodayQueue({
      candidates: [violationMid, parcelTop, violationTop],
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: { ...DEFAULT_TODAY_CAPACITY, explorationSlots: 2 },
      completedDiscretionaryDialCount: 0,
    });
    const exploration = queue.lanes.find(({ lane }) => lane === 'exploration')!;
    expect(exploration.items.map(({ cycleId }) => cycleId)).toEqual([
      violationTop.cycleId, parcelTop.cycleId,
    ]);
    const later = queue.lanes.find(({ lane }) => lane === 'later')!;
    expect(later.items.map(({ cycleId }) => cycleId)).toEqual([violationMid.cycleId]);
  });

  it('keeps a pinned row first inside its lane only', () => {
    const queue = planTodayQueue({
      candidates: [
        candidate({ priority: prioritySnapshot({ effectivePriority: 'p1' }) }),
        candidate({ priority: prioritySnapshot({ effectivePriority: 'p1', pin: true }) }),
      ],
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: 0,
    });
    const p1Lane = queue.lanes.find(({ lane }) => lane === 'p1')!;
    expect(p1Lane.items[0]!.pinned).toBe(true);
  });
});

describe('planTodayQueue capacity', () => {
  it('caps automatic dials at dialBudget rows with per-lane overflow counts', () => {
    const candidates = Array.from({ length: 12 }, () => candidate({
      action: { workIntent: 'promised_follow_up' },
    }));
    const queue = planTodayQueue({
      candidates,
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: { ...DEFAULT_TODAY_CAPACITY, dialBudget: 5 },
      completedDiscretionaryDialCount: 0,
    });
    const dueCadence = queue.lanes.find(({ lane }) => lane === 'due_primary')!;
    const later = queue.lanes.find(({ lane }) => lane === 'later')!;
    expect(dueCadence.items).toHaveLength(5);
    expect(dueCadence.overflowCount).toBe(7);
    expect(later.items).toHaveLength(7);
    expect(later.items.every(({ laneReason }) => laneReason === 'capacity_overflow')).toBe(true);
    const total = queue.lanes.reduce((count, { items }) => count + items.length, 0);
    expect(total).toBe(12);
  });

  it('cuts lower-rank lanes before higher-rank lanes', () => {
    const queue = planTodayQueue({
      candidates: [
        candidate({ action: { workIntent: 'inbound_response' } }),
        candidate({ action: { workIntent: 'promised_follow_up' } }),
        candidate({ priority: prioritySnapshot({ effectivePriority: 'p0' }) }),
        candidate({ priority: prioritySnapshot({ effectivePriority: 'p1' }) }),
      ],
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: { ...DEFAULT_TODAY_CAPACITY, dialBudget: 2 },
      completedDiscretionaryDialCount: 0,
    });
    const lanesById = new Map(queue.lanes.map((lane) => [lane.lane, lane]));
    expect(lanesById.get('inbound_interrupt')!.items).toHaveLength(1);
    expect(lanesById.get('due_primary')!.items).toHaveLength(1);
    expect(lanesById.get('new_p0')!.items).toHaveLength(1);
    expect(lanesById.get('p1')!.items).toHaveLength(0);
    expect(lanesById.get('p1')!.overflowCount).toBe(1);
    expect(lanesById.get('later')!.items).toHaveLength(1);
  });

  it('keeps exploration to its configured slots with quota overflow to Later', () => {
    const queue = planTodayQueue({
      candidates: [
        candidate({ priority: prioritySnapshot({ effectivePriority: 'p2' }) }),
        candidate({ priority: prioritySnapshot({ effectivePriority: 'p2' }) }),
        candidate({ priority: prioritySnapshot({ effectivePriority: 'p3' }) }),
      ],
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: { ...DEFAULT_TODAY_CAPACITY, explorationSlots: 2 },
      completedDiscretionaryDialCount: 0,
    });
    const exploration = queue.lanes.find(({ lane }) => lane === 'exploration')!;
    const later = queue.lanes.find(({ lane }) => lane === 'later')!;
    expect(exploration.items).toHaveLength(2);
    expect(later.items).toHaveLength(1);
    expect(later.items[0]!.laneReason).toBe('exploration_quota_overflow');
  });

  it('carries the unreviewed backlog count through untouched', () => {
    const queue = planTodayQueue({
      candidates: [],
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: 0,
      unreviewedBacklogCount: 17,
    });
    expect(queue.unreviewedBacklogCount).toBe(17);
  });

  it('accounts every candidate exactly once across lanes, later, suppressed, diagnostics', () => {
    const inputs = [
      candidate({ stage: 'won', workflowStatus: 'onboarding', action: { workIntent: 'promised_follow_up' } }),
      candidate({ action: { workIntent: 'inbound_response' } }),
      candidate({ action: { workIntent: 'promised_follow_up' } }),
      candidate({ priority: prioritySnapshot({ effectivePriority: 'p0' }) }),
      candidate({ priority: prioritySnapshot({ effectivePriority: 'p2' }) }),
      candidate({ priority: prioritySnapshot({ snooze: true }) }),
      candidate({ resurfaceAt: '2026-09-05T00:00:00.000Z', resurfaceReason: 'callback' }),
      candidate({ priority: null, priorityState: 'missing' }),
    ];
    const queue = planTodayQueue({
      candidates: inputs,
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: 0,
    });
    const laneCount = queue.lanes.reduce((count, { items }) => count + items.length, 0);
    expect(laneCount + queue.suppressed.length + queue.diagnostics.length).toBe(inputs.length);
    expect(queue.suppressed.map(({ reason }) => reason).sort()).toEqual(
      ['resurface_scheduled', 'snoozed'],
    );
  });

  it('flags duplicate cycle candidates as diagnostics', () => {
    const original = candidate();
    const duplicate = { ...candidate(), cycleId: original.cycleId };
    const queue = planTodayQueue({
      candidates: [original, duplicate],
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: 0,
    });
    expect(queue.diagnostics).toHaveLength(1);
    expect(queue.diagnostics[0]).toMatchObject({ kind: 'duplicate_candidate' });
  });

  it('is byte-deterministic and mutates no inputs', () => {
    const inputs = [
      candidate({ priority: prioritySnapshot({ effectivePriority: 'p0' }) }),
      candidate({ action: { workIntent: 'promised_follow_up' } }),
    ];
    const frozen = JSON.stringify(inputs);
    const first = planTodayQueue({
      candidates: inputs,
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: 0,
    });
    const second = planTodayQueue({
      candidates: inputs,
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: 0,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(inputs)).toBe(frozen);
    expect(Object.isFrozen(first)).toBe(true);
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
    expect(() => planTodayQueue({
      candidates: [],
      generatedAt: GENERATED_AT,
      timezone: 'America/New_York',
      capacity: DEFAULT_TODAY_CAPACITY,
      completedDiscretionaryDialCount: 0,
      unreviewedBacklogCount: -3,
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
