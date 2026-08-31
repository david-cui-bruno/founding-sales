import { describe, expect, it } from 'vitest';

import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  classifyStoredTriggerKey,
  evaluateTriggers,
} from '../../src/main/domain/prioritization/triggerMath';
import type {
  TriggerEvent,
  TriggerEvidenceV1,
} from '../../src/main/domain/prioritization/prioritizationTypes';
import { PrioritizationInputCorruptionError } from '../../src/main/domain/support/domainErrors';

const RULE = BUILTIN_PRIORITIZATION_RULE_V1;
const T0 = '2026-08-01T00:00:00.000Z';
const T0_MILLIS = Date.parse(T0);
const DAY_MILLIS = 86_400_000;

const at = (millisFromT0: number): string => new Date(T0_MILLIS + millisFromT0).toISOString();

function decayEvidence(triggerType: string): TriggerEvidenceV1 {
  return {
    formatVersion: 1,
    triggerType: triggerType as 'live_vacancy',
    authoredUnderRuleVersionId: 'rule-1',
    evidenceRefs: ['ref-1'],
    function: 'decaying',
    proof: { kind: 'source_event', sourceEventId: 'source-1', sourceObservedAt: T0 },
  };
}

function event(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  const triggerType = overrides.triggerType ?? 'live_vacancy';
  return {
    id: 'event-1',
    prospectId: 'prospect-1',
    sourceEventId: 'source-1',
    reactivationReceiptActivationKey: null,
    reactivationRuleId: null,
    triggerType,
    effectiveAt: T0,
    expiresAt: null,
    strengthMultiplier: 1,
    verificationState: 'verified',
    evidence: decayEvidence(triggerType),
    createdAt: T0,
    ...overrides,
  };
}

function windowEvent(overrides: {
  id?: string;
  triggerType?: 'heating_season' | 'student_turnover' | 'tax_season' | 'nurture_resurrection';
  effectiveAt?: string;
  startsAt: string;
  endsAt: string;
  verificationState?: 'verified' | 'unverified';
}): TriggerEvent {
  const triggerType = overrides.triggerType ?? 'heating_season';
  return event({
    id: overrides.id ?? 'window-1',
    triggerType,
    effectiveAt: overrides.effectiveAt ?? overrides.startsAt,
    expiresAt: overrides.endsAt,
    verificationState: overrides.verificationState ?? 'verified',
    evidence: {
      formatVersion: 1,
      triggerType: triggerType as 'heating_season',
      authoredUnderRuleVersionId: 'rule-1',
      evidenceRefs: ['ref-1'],
      function: 'windowed',
      startsAt: overrides.startsAt,
      endsAt: overrides.endsAt,
      proof: { kind: 'source_event', sourceEventId: 'source-1', sourceObservedAt: T0 },
    },
  });
}

describe('classifyStoredTriggerKey', () => {
  it('accepts built-ins and valid custom slugs and rejects malformed keys', () => {
    expect(classifyStoredTriggerKey('live_vacancy')).toEqual({ kind: 'builtin', key: 'live_vacancy' });
    expect(classifyStoredTriggerKey('custom:roof-permits-2026'))
      .toEqual({ kind: 'custom', key: 'custom:roof-permits-2026' });
    expect(() => classifyStoredTriggerKey('custom:Bad_Slug'))
      .toThrow(PrioritizationInputCorruptionError);
    expect(() => classifyStoredTriggerKey('custom:'))
      .toThrow(PrioritizationInputCorruptionError);
    expect(() => classifyStoredTriggerKey('lead_vacancy'))
      .toThrow(PrioritizationInputCorruptionError);
  });
});

describe('evaluateTriggers decay', () => {
  it('is exactly base at the effective instant and halves per half-life', () => {
    const result = evaluateTriggers({ events: [event()], rule: RULE, evaluatedAt: T0 });
    expect(result.timingMilliPoints).toBe(15_000);
    const oneHalfLife = evaluateTriggers({
      events: [event()], rule: RULE, evaluatedAt: at(14 * DAY_MILLIS),
    });
    expect(oneHalfLife.timingMilliPoints).toBe(7_500);
  });

  it('is zero before the effective instant', () => {
    const result = evaluateTriggers({
      events: [event({ effectiveAt: at(DAY_MILLIS) })], rule: RULE, evaluatedAt: T0,
    });
    expect(result.timingMilliPoints).toBe(0);
    expect(result.reasons[0]).toMatchObject({ code: 'not_yet_effective', selected: false });
  });

  it('applies the <1.0 threshold to the unrounded value: exactly 1.0 contributes', () => {
    // base 15, half-life 14 days: value 1.0 at 14 * log2(15) days after T0.
    const thresholdInstantExact = T0_MILLIS + 14 * DAY_MILLIS * Math.log2(15);
    const thresholdFloor = Math.floor(thresholdInstantExact);
    const before = evaluateTriggers({
      events: [event()], rule: RULE, evaluatedAt: new Date(thresholdFloor).toISOString(),
    });
    expect(before.timingMilliPoints).toBe(1_000);
    const after = evaluateTriggers({
      events: [event()], rule: RULE, evaluatedAt: new Date(thresholdFloor + 1).toISOString(),
    });
    expect(after.timingMilliPoints).toBe(0);
    expect(after.reasons[0]).toMatchObject({ code: 'below_threshold' });
    // The recomputed expiration is the first representable ms below 1.0.
    expect(before.reasons[0]!.recomputedExpiresAt)
      .toBe(new Date(thresholdFloor + 1).toISOString());
  });

  it('applies the 0.6 unverified multiplier to the unrounded value', () => {
    const result = evaluateTriggers({
      events: [event({ verificationState: 'unverified' })], rule: RULE, evaluatedAt: T0,
    });
    expect(result.timingMilliPoints).toBe(9_000);
  });

  it('applies strength multipliers and rejects out-of-range values', () => {
    expect(evaluateTriggers({
      events: [event({ strengthMultiplier: 2 })], rule: RULE, evaluatedAt: T0,
    }).timingMilliPoints).toBe(30_000);
    expect(() => evaluateTriggers({
      events: [event({ strengthMultiplier: 2.1 })], rule: RULE, evaluatedAt: T0,
    })).toThrow(PrioritizationInputCorruptionError);
  });

  it('honours an earlier source hard stop exclusively', () => {
    const hardStop = at(2 * DAY_MILLIS);
    const active = evaluateTriggers({
      events: [event({ expiresAt: hardStop })],
      rule: RULE,
      evaluatedAt: at(2 * DAY_MILLIS - 1),
    });
    expect(active.timingMilliPoints).toBeGreaterThan(0);
    expect(active.reasons[0]!.recomputedExpiresAt).toBe(hardStop);
    const stopped = evaluateTriggers({
      events: [event({ expiresAt: hardStop })], rule: RULE, evaluatedAt: hardStop,
    });
    expect(stopped.timingMilliPoints).toBe(0);
    expect(stopped.reasons[0]).toMatchObject({ code: 'expired' });
  });

  it('rejects a hard stop at or before the effective instant', () => {
    expect(() => evaluateTriggers({
      events: [event({ expiresAt: T0 })], rule: RULE, evaluatedAt: T0,
    })).toThrow(PrioritizationInputCorruptionError);
  });
});

describe('evaluateTriggers windows', () => {
  it('is half-open active on [max(effective, startsAt), endsAt)', () => {
    const startsAt = at(DAY_MILLIS);
    const endsAt = at(3 * DAY_MILLIS);
    const window = windowEvent({ startsAt, endsAt, effectiveAt: T0 });
    expect(evaluateTriggers({ events: [window], rule: RULE, evaluatedAt: T0 })
      .reasons[0]).toMatchObject({ code: 'window_inactive' });
    expect(evaluateTriggers({ events: [window], rule: RULE, evaluatedAt: startsAt })
      .timingMilliPoints).toBe(5_000);
    expect(evaluateTriggers({ events: [window], rule: RULE, evaluatedAt: at(3 * DAY_MILLIS - 1) })
      .timingMilliPoints).toBe(5_000);
    expect(evaluateTriggers({ events: [window], rule: RULE, evaluatedAt: endsAt })
      .reasons[0]).toMatchObject({ code: 'expired' });
  });

  it('never backdates: evidence observed mid-window starts at effective_at', () => {
    const startsAt = T0;
    const endsAt = at(10 * DAY_MILLIS);
    const observedMidWindow = windowEvent({
      startsAt, endsAt, effectiveAt: at(4 * DAY_MILLIS),
    });
    expect(evaluateTriggers({
      events: [observedMidWindow], rule: RULE, evaluatedAt: at(2 * DAY_MILLIS),
    }).reasons[0]).toMatchObject({ code: 'not_yet_effective' });
    expect(evaluateTriggers({
      events: [observedMidWindow], rule: RULE, evaluatedAt: at(4 * DAY_MILLIS),
    }).timingMilliPoints).toBe(5_000);
  });

  it('rejects inverted or effective-after-end windows', () => {
    expect(() => evaluateTriggers({
      events: [windowEvent({ startsAt: at(DAY_MILLIS), endsAt: at(DAY_MILLIS) })],
      rule: RULE,
      evaluatedAt: T0,
    })).toThrow(PrioritizationInputCorruptionError);
    expect(() => evaluateTriggers({
      events: [windowEvent({
        startsAt: T0, endsAt: at(DAY_MILLIS), effectiveAt: at(2 * DAY_MILLIS),
      })],
      rule: RULE,
      evaluatedAt: T0,
    })).toThrow(PrioritizationInputCorruptionError);
  });
});

describe('evaluateTriggers compliance approaching', () => {
  const deadlineAt = at(100 * DAY_MILLIS);

  function complianceEvent(id = 'compliance-1'): TriggerEvent {
    return event({
      id,
      triggerType: 'compliance_deadline',
      effectiveAt: T0,
      evidence: {
        formatVersion: 1,
        triggerType: 'compliance_deadline',
        authoredUnderRuleVersionId: 'rule-1',
        evidenceRefs: ['ref-1'],
        function: 'approaching',
        deadlineAt,
        proof: { kind: 'source_event', sourceEventId: 'source-1', sourceObservedAt: T0 },
      },
    });
  }

  it('is zero before deadline-90d, 25% at 90d, linear to 100% at 30d, holds until +14d exclusive', () => {
    const evaluate = (millisFromT0: number): number => evaluateTriggers({
      events: [complianceEvent()], rule: RULE, evaluatedAt: at(millisFromT0),
    }).timingMilliPoints;
    // 91 days before deadline: zero.
    expect(evaluate(9 * DAY_MILLIS)).toBe(0);
    // Exactly 90 days before: 25% of 10 = 2.5.
    expect(evaluate(10 * DAY_MILLIS)).toBe(2_500);
    // 60 days before: halfway 0.25 -> 1.0 = 0.625 of 10.
    expect(evaluate(40 * DAY_MILLIS)).toBe(6_250);
    // 30 days before through the deadline: 100%.
    expect(evaluate(70 * DAY_MILLIS)).toBe(10_000);
    expect(evaluate(100 * DAY_MILLIS)).toBe(10_000);
    // Deadline + 13 days: still 100%. Deadline + 14 days: expired.
    expect(evaluate(113 * DAY_MILLIS)).toBe(10_000);
    expect(evaluate(114 * DAY_MILLIS)).toBe(0);
  });
});

describe('custom trigger keys', () => {
  it('contributes zero with custom_not_configured when absent from the rule', () => {
    const custom = event({
      id: 'custom-1',
      triggerType: 'custom:roof-permit',
      evidence: {
        formatVersion: 1,
        triggerType: 'custom:roof-permit',
        authoredUnderRuleVersionId: 'rule-1',
        evidenceRefs: ['ref-1'],
        function: 'decaying',
        proof: { kind: 'source_event', sourceEventId: 'source-1', sourceObservedAt: T0 },
      },
    });
    const result = evaluateTriggers({ events: [custom], rule: RULE, evaluatedAt: T0 });
    expect(result.timingMilliPoints).toBe(0);
    expect(result.reasons[0]).toMatchObject({ code: 'custom_not_configured', selected: false });
  });

  it('rejects malformed custom keys as corruption', () => {
    const malformed = event({ id: 'bad', triggerType: 'custom:Bad Slug' as never });
    expect(() => evaluateTriggers({ events: [malformed], rule: RULE, evaluatedAt: T0 }))
      .toThrow(PrioritizationInputCorruptionError);
  });
});

describe('selection, ties, cap, and explanations', () => {
  it('selects only the strongest active event per full stored key', () => {
    const strong = event({ id: 'strong', effectiveAt: T0 });
    const weak = event({ id: 'weak', effectiveAt: at(-14 * DAY_MILLIS) });
    const result = evaluateTriggers({
      events: [weak, strong], rule: RULE, evaluatedAt: T0,
    });
    expect(result.timingMilliPoints).toBe(15_000);
    const strongReason = result.reasons.find((reason) => reason.eventId === 'strong')!;
    const weakReason = result.reasons.find((reason) => reason.eventId === 'weak')!;
    expect(strongReason).toMatchObject({ selected: true, contributed: true });
    expect(weakReason).toMatchObject({
      selected: false, contributed: false, code: 'suppressed', winningEventId: 'strong',
    });
  });

  it('breaks equal-thousandth ties by earliest expiration, then effective_at, then event ID', () => {
    const endsAt = at(30 * DAY_MILLIS);
    const laterEnd = at(40 * DAY_MILLIS);
    const early = windowEvent({ id: 'w-early', startsAt: T0, endsAt });
    const late = windowEvent({ id: 'w-late', startsAt: T0, endsAt: laterEnd });
    const tie = evaluateTriggers({
      events: [late, early], rule: RULE, evaluatedAt: at(DAY_MILLIS),
    });
    expect(tie.reasons.find((reason) => reason.selected)!.eventId).toBe('w-early');

    const idTieLeft = windowEvent({ id: 'w-a', startsAt: T0, endsAt });
    const idTieRight = windowEvent({ id: 'w-b', startsAt: T0, endsAt });
    const idTie = evaluateTriggers({
      events: [idTieRight, idTieLeft], rule: RULE, evaluatedAt: at(DAY_MILLIS),
    });
    expect(idTie.reasons.find((reason) => reason.selected)!.eventId).toBe('w-a');
  });

  it('caps the sum at 40000 while earliest expiration still reflects every selected contributor', () => {
    const events: TriggerEvent[] = [
      event({ id: 'demo', triggerType: 'inbound_demo', evidence: decayEvidence('inbound_demo'), strengthMultiplier: 2 }),
      event({ id: 'referral', triggerType: 'direct_referral', evidence: decayEvidence('direct_referral') }),
      event({ id: 'vacancy', triggerType: 'live_vacancy', evidence: decayEvidence('live_vacancy') }),
    ];
    const result = evaluateTriggers({ events, rule: RULE, evaluatedAt: T0 });
    expect(result.uncappedMilliPoints).toBe(60_000 + 25_000 + 15_000);
    expect(result.timingMilliPoints).toBe(40_000);
    expect(result.timingBand).toBe('hot');
    // inbound_demo has the shortest half-life so the earliest recomputed expiration.
    const demoReason = result.reasons.find((reason) => reason.eventId === 'demo')!;
    expect(result.earliestTriggerExpiresAt).toBe(demoReason.recomputedExpiresAt);
  });

  it('maps exact band boundaries', () => {
    const bandFor = (milliPoints: number): string => {
      if (milliPoints <= 7_999) return 'cold';
      if (milliPoints <= 19_999) return 'warm';
      return 'hot';
    };
    expect(bandFor(0)).toBe('cold');
    expect(bandFor(7_999)).toBe('cold');
    expect(bandFor(8_000)).toBe('warm');
    expect(bandFor(19_999)).toBe('warm');
    expect(bandFor(20_000)).toBe('hot');
    const cold = evaluateTriggers({ events: [], rule: RULE, evaluatedAt: T0 });
    expect(cold.timingBand).toBe('cold');
    expect(cold.timingMilliPoints).toBe(0);
    expect(cold.earliestTriggerExpiresAt).toBeNull();
  });

  it('stable-sorts reasons by stored key, selected first, then event ID', () => {
    const events = [
      event({ id: 'z-vacancy', triggerType: 'live_vacancy', evidence: decayEvidence('live_vacancy') }),
      event({ id: 'a-vacancy', triggerType: 'live_vacancy', evidence: decayEvidence('live_vacancy'), effectiveAt: at(-DAY_MILLIS) }),
      event({ id: 'demo', triggerType: 'inbound_demo', evidence: decayEvidence('inbound_demo') }),
    ];
    const result = evaluateTriggers({ events, rule: RULE, evaluatedAt: T0 });
    expect(result.reasons.map((reason) => [reason.triggerKey, reason.eventId, reason.selected]))
      .toEqual([
        ['inbound_demo', 'demo', true],
        ['live_vacancy', 'z-vacancy', true],
        ['live_vacancy', 'a-vacancy', false],
      ]);
  });

  it('is order-insensitive, duplicate-tolerant, and rejects conflicting duplicate IDs', () => {
    const first = event({ id: 'e1' });
    const second = event({ id: 'e2', triggerType: 'inbound_demo', evidence: decayEvidence('inbound_demo') });
    const forward = evaluateTriggers({ events: [first, second], rule: RULE, evaluatedAt: T0 });
    const backward = evaluateTriggers({
      events: [second, first, second], rule: RULE, evaluatedAt: T0,
    });
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
    expect(() => evaluateTriggers({
      events: [first, { ...first, strengthMultiplier: 2 }], rule: RULE, evaluatedAt: T0,
    })).toThrow(PrioritizationInputCorruptionError);
  });

  it('changing only trigger evidence cannot alter unrelated keys', () => {
    const vacancy = event({ id: 'vacancy' });
    const before = evaluateTriggers({ events: [vacancy], rule: RULE, evaluatedAt: T0 });
    const withDemo = evaluateTriggers({
      events: [vacancy, event({ id: 'demo', triggerType: 'inbound_demo', evidence: decayEvidence('inbound_demo') })],
      rule: RULE,
      evaluatedAt: T0,
    });
    const vacancyBefore = before.reasons.find((reason) => reason.eventId === 'vacancy')!;
    const vacancyAfter = withDemo.reasons.find((reason) => reason.eventId === 'vacancy')!;
    expect(vacancyAfter.contributionMilliPoints).toBe(vacancyBefore.contributionMilliPoints);
    expect(vacancyAfter.recomputedExpiresAt).toBe(vacancyBefore.recomputedExpiresAt);
  });

  it('rejects evidence whose function or key contradicts the rule entry', () => {
    const mismatchedFunction = event({
      id: 'bad-function',
      triggerType: 'heating_season',
      evidence: decayEvidence('heating_season'),
    });
    expect(() => evaluateTriggers({
      events: [mismatchedFunction], rule: RULE, evaluatedAt: T0,
    })).toThrow(PrioritizationInputCorruptionError);
    const mismatchedKey = event({
      id: 'bad-key',
      triggerType: 'live_vacancy',
      evidence: decayEvidence('post_storm'),
    });
    expect(() => evaluateTriggers({
      events: [mismatchedKey], rule: RULE, evaluatedAt: T0,
    })).toThrow(PrioritizationInputCorruptionError);
  });
});
