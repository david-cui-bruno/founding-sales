import { describe, expect, it } from 'vitest';

import { buildDiscoveryQuestions } from '../../src/main/domain/discovery/discoveryBrief';
import {
  compareDiscoveryCandidates, evaluateDiscovery, selectDiscoveryCandidates,
} from '../../src/main/domain/discovery/discoveryPolicy';
import type { DiscoveryEvidenceSnapshot } from '../../src/main/domain/discovery/discoveryTypes';
import type { DiscoveryAssessment, DiscoveryClaim } from '../../src/shared/contracts/discoveryContract';
import { discoveryAssessmentSchema } from '../../src/shared/contracts/discoveryContract';
import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import type { PropertyFact, TriggerEvent } from '../../src/main/domain/prioritization/prioritizationTypes';
import { evidence } from '../fixtures/discoveryEvidence';

const AS_OF = '2026-09-06T12:00:00.000Z';
const RULE = BUILTIN_PRIORITIZATION_RULE_V1;
const evaluate = (overrides: Partial<DiscoveryEvidenceSnapshot> = {}) => evaluateDiscovery({ snapshot: evidence(overrides), rule: RULE, asOf: AS_OF });
const property = (overrides: Partial<PropertyFact> = {}): PropertyFact => ({ ...evidence().properties[0]!, ...overrides });
function assessment(personId: string, exploration = false): DiscoveryAssessment {
  return {
    ...evaluate({ personId, prospectId: `prospect-${personId}`, salesCycleId: `cycle-${personId}`,
      properties: [property(exploration ? { doorCount: null, verifiedAt: null } : {})] }),
    id: '11111111-1111-4111-8111-111111111111', modelVersion: null,
    evaluatedAt: AS_OF, expiresAt: '2026-09-07T04:00:00.000Z',
    localDate: '2026-09-06', overrideId: null,
  };
}
function trigger(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    id: 'trigger-1', prospectId: 'prospect-1', sourceEventId: 'source-1',
    reactivationReceiptActivationKey: null, reactivationRuleId: null,
    triggerType: 'live_vacancy', effectiveAt: AS_OF, expiresAt: null,
    strengthMultiplier: 1, verificationState: 'verified', createdAt: AS_OF,
    evidence: { formatVersion: 1, triggerType: 'live_vacancy', authoredUnderRuleVersionId: RULE.id,
      function: 'decaying', evidenceRefs: ['registry:1'],
      proof: { kind: 'source_event', sourceEventId: 'source-1', sourceObservedAt: AS_OF } },
    ...overrides,
  };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe('pure discovery evaluation', () => {
  it('explores a supported named owner without pretending Unreviewed is Eligible or penalizing missing contact', () => {
    const snapshot = freeze(evidence());
    const result = evaluateDiscovery({ snapshot, rule: RULE, asOf: AS_OF });
    expect(result.disposition).toBe('candidate');
    expect(result.axes.fit).toEqual({ points: 15, band: 'medium', completeness: 'partial' });
    expect(result.axes.reachability).toBe('none');
    expect(result.axes.timing).toEqual({ milliPoints: 0, band: 'cold', hasSupportedTrigger: false });
    expect(result.unknowns).toContain('No current trigger established');
    expect(result.questions).toContain('Do you handle maintenance yourself or use a property manager?');
    expect(result.unknowns.join(' ')).toMatch(/management/i);
    expect(result.ranking.priority).toBe('p3');
    expect(result).toMatchObject({ personId: snapshot.personId, prospectId: snapshot.prospectId,
      salesCycleId: snapshot.salesCycleId, fingerprint: snapshot.inputFingerprint, ruleVersionId: RULE.id, policyVersion: 'discovery-v1' });
    expect(result).not.toHaveProperty('evaluatedAt');
    expect(result).not.toHaveProperty('localDate');
    expect(result).not.toHaveProperty('overrideId');
    expect(snapshot.qualificationState).toBe('unreviewed');
    const contactable = evaluate({ contacts: [{ id: 'phone-1', kind: 'phone', validationState: 'valid', reachability: 'direct' }] });
    expect(contactable.axes.fit).toEqual(result.axes.fit);
    expect(contactable.disposition).toBe('candidate');
  });

  it('distinguishes actual zero from missing Fit and never invents a priority for null-Fit exploration', () => {
    const missing = evaluate({ properties: [property({ doorCount: null, verifiedAt: null })] });
    expect(missing.axes.fit).toBeNull();
    expect(missing.disposition).toBe('candidate');
    expect(missing.ranking.priority).toBeNull();
    const zero = evaluate({ properties: [property({ doorCount: 0 })] });
    expect(zero.axes.fit).toEqual({ points: 0, band: 'low', completeness: 'partial' });
    expect(zero.disposition).toBe('candidate');
    expect(zero.ranking.priority).toBeNull();
    expect(evaluate({ properties: [] }).disposition).toBe('research');
  });

  it.each([
    { operationallyBlocked: true }, { workflowStatus: 'closed' as const },
    { workflowStatus: 'onboarding' as const },
    { qualificationState: 'disqualified' as const, qualificationGateReason: 'harmful_operator' },
  ])('lets actual block win over ambiguity and missing identity: %j', block => {
    const result = evaluate({ ...block, unresolvedIdentity: true, conflicts: [{ kind: 'identity', claimIds: ['ownership-1'] }] });
    expect(result.disposition).toBe('excluded');
    expect(result.reasonCodes).toContain('existing_operational_or_qualification_block');
    expect(result.axes.fit).toBeNull();
    expect(result.questions).toEqual([]);
  });

  it('routes merge review to judgment but missing/unsupported identity to research', () => {
    expect(evaluate({ qualificationState: 'merge_review', unresolvedIdentity: true }).disposition).toBe('judgment');
    for (const identity of [{ unresolvedIdentity: true }, { identitySupported: false, personName: 'A nonempty LLC' }]) {
      expect(evaluate(identity)).toMatchObject({ disposition: 'research', needsResearch: true, reasonCodes: ['owner_identity_unknown'] });
    }
  });

  it('surfaces full-evidence conflicts with stable reason codes and cited claims before scoring', () => {
    const first = evidence().validatedClaims[0]!;
    const second: DiscoveryClaim = { ...first, id: 'ownership-2', value: 'Another owner' };
    const result = evaluate({ claims: [], validatedClaims: [second, first],
      properties: [property({ doorCount: -1 })],
      conflicts: [{ kind: 'ownership', claimIds: ['ownership-2', 'ownership-1'] }, { kind: 'identity', claimIds: ['ownership-1'] }],
    });
    expect(result.disposition).toBe('judgment');
    expect(result.axes.fit).toBeNull();
    expect(result.reasonCodes).toEqual(['identity_conflict', 'ownership_conflict']);
    expect(result.claims.map(c => c.id)).toEqual(['ownership-1', 'ownership-2']);
    expect(result.claims.every(c => c.refs.length > 0)).toBe(true);
  });

  it('ignores unsupported self-managed flags and heuristic organization-name claims', () => {
    const heuristic: DiscoveryClaim = { id: 'heuristic', label: 'Probably self-managed', value: true, certainty: 'inference', refs: [] };
    const result = evaluate({ claims: [...evidence().claims, heuristic], properties: [property({
      maintenanceProfile: { formatVersion: 1, management: 'unknown', relevantProfile: 'unknown', evidenceRefs: [] },
    })] });
    expect(result.axes.fit).toEqual({ points: 15, band: 'medium', completeness: 'partial' });
    expect(result.claims.find(c => c.id === 'heuristic')?.certainty).toBe('inference');
    expect(result.questions).toContain('Do you handle maintenance yourself or use a property manager?');
    expect(result.reasonCodes.join(' ')).not.toMatch(/non_paying|disqualif/);
  });

  it('scores collector-admitted door counts without requiring a verification timestamp', () => {
    const result = evaluate({ properties: [property({ verifiedAt: null })] });
    expect(result.axes.fit).toEqual({ points: 15, band: 'medium', completeness: 'partial' });
    expect(result.disposition).toBe('candidate');
  });

  it('marks all supported rubric inputs complete without excluding a supported low-Fit owner', () => {
    const complete = evaluate({ properties: [property({ doorCount: 0, maintenanceProfile: {
      formatVersion: 1, management: 'third_party', relevantProfile: false, evidenceRefs: ['registry:1'],
    } })] });
    expect(complete.axes.fit).toEqual({ points: 0, band: 'low', completeness: 'complete' });
    expect(complete.disposition).toBe('watch');
    expect(complete.reasonCodes).not.toContain('non_paying_operator');
  });

  it('uses the real trigger decay, expiry and separate millipoint Timing axis', () => {
    expect(evaluate({ triggers: [trigger()] }).axes.timing).toEqual({ milliPoints: 15_000, band: 'warm', hasSupportedTrigger: true });
    const expired = trigger({ effectiveAt: '2026-09-01T12:00:00.000Z', expiresAt: AS_OF });
    const result = evaluate({ triggers: [expired] });
    expect(result.axes.timing).toEqual({ milliPoints: 0, band: 'cold', hasSupportedTrigger: false });
    expect(result.ranking.earliestTriggerExpiresAt).toBeNull();
    expect(result.unknowns).toContain('No current trigger established');
    expect(result.axes.fit?.points).toBe(15);
  });

  it('rejects incoherent admitted trigger tuples without claiming database proof verification', () => {
    for (const invalid of [trigger({ prospectId: 'other-prospect' }), trigger({ sourceEventId: null }),
      trigger({ evidence: { ...trigger().evidence, evidenceRefs: [' '] } }),
    ]) expect(evaluate({ triggers: [invalid] }).axes.timing.milliPoints).toBe(0);
  });

  it('keeps supported unverified triggers distinct from a heuristic that was never admitted', () => {
    const supported = evaluate({ triggers: [trigger({ verificationState: 'unverified' })] });
    expect(supported.axes.timing).toEqual({ milliPoints: 9_000, band: 'warm', hasSupportedTrigger: true });
    const heuristic: DiscoveryClaim = { id: 'possible-vacancy', label: 'Possible vacancy',
      value: true, certainty: 'inference', refs: [] };
    expect(evaluate({ claims: [heuristic] }).axes.timing)
      .toEqual({ milliPoints: 0, band: 'cold', hasSupportedTrigger: false });
  });

  it('does not return future supported evidence or conversations as a valid as-of assessment', () => {
    const future = '2026-09-07T12:00:00.000Z';
    const claim: DiscoveryClaim = { ...evidence().validatedClaims[0]!, refs: [{
      kind: 'source', sourceEventId: 'source-2', field: 'owner', observedAt: future,
    }] };
    expect(() => evaluate({ validatedClaims: [claim] })).toThrow(/future/i);
    expect(() => evaluate({ lastConversationAt: future, conversationActivityIds: ['conversation-1'] })).toThrow(/future/i);
  });

  it('uses supported observation freshness, not verification time or heuristic recency', () => {
    const first = evidence().validatedClaims[0]!;
    const newer: DiscoveryClaim = { ...first, id: 'newer', refs: [{ kind: 'source', sourceEventId: 'source-2', field: 'owner', observedAt: '2026-09-06T11:00:00.000Z' }] };
    const result = evaluate({ validatedClaims: [first, newer], claims: [first],
      properties: [property({ verifiedAt: AS_OF })] });
    expect(result.ranking.latestSourceObservedAt).toBe('2026-09-06T11:00:00.000Z');
    const old = evaluate({ originalSource: { ...evidence().originalSource, observedAt: '2025-01-01T12:00:00.000Z' } });
    expect(old.ranking.dataConfidence).toBeLessThan(evaluate().ranking.dataConfidence);
  });

  it('respects future resurfacing and rejects mismatched rule identity instead of mislabeling scores', () => {
    expect(evaluate({ resurfaceAt: '2026-09-07T12:00:00.000Z' }).disposition).toBe('watch');
    expect(evaluate({ resurfaceAt: AS_OF }).disposition).toBe('candidate');
    expect(() => evaluate({ ruleVersionId: 'different-rule' })).toThrow(/rule/i);
  });

  it('asks at most three grounded questions, distinguishes US proposition from Texas evidence, and promises no pilot', () => {
    const snapshot = evidence();
    const questions = buildDiscoveryQuestions(snapshot);
    expect(questions.length).toBeLessThanOrEqual(3);
    expect(questions.every(q => q.endsWith('?'))).toBe(true);
    expect(questions.join(' ')).toMatch(/US-wide/);
    expect(questions.join(' ')).toMatch(/Texas/);
    expect(questions.join(' ')).not.toMatch(/free|guarantee|pilot|(?:^|[.!] )you (?:have|need|struggle)/i);
    const texas = evaluate({ properties: [property({ region: 'TX', locality: 'Austin' })] });
    expect(texas.axes.fit).toEqual(evaluate().axes.fit);
    expect(buildDiscoveryQuestions(evidence({ properties: [property({ doorCount: null })] })).join(' ')).toMatch(/units/i);
    expect(evaluate()).not.toHaveProperty('pilotNextStep');
  });

  it('is deterministic with immutable input and every disposition can be persisted by the strict schema', () => {
    for (const changes of [{}, { unresolvedIdentity: true }, { qualificationState: 'merge_review' as const }, { operationallyBlocked: true }, { resurfaceAt: '2026-09-08T12:00:00.000Z' }]) {
      const snapshot = freeze(evidence(changes));
      const result = evaluateDiscovery({ snapshot, rule: RULE, asOf: AS_OF });
      expect(evaluateDiscovery({ snapshot, rule: RULE, asOf: AS_OF })).toEqual(result);
      expect(discoveryAssessmentSchema.safeParse({ ...assessment('person-1'), ...result }).success).toBe(true);
    }
  });
});

describe('advisory candidate order and allocation', () => {
  it('orders primary by canonical local priority and prospect ID, not sales cycle ID', () => {
    const a = assessment('a');
    const b = assessment('b');
    a.salesCycleId = 'z-cycle';
    b.salesCycleId = 'a-cycle';
    expect(compareDiscoveryCandidates(a, b)).toBeLessThan(0);
    b.axes.timing = { milliPoints: 15_000, band: 'warm', hasSupportedTrigger: true };
    b.ranking.priority = 'p2';
    expect(compareDiscoveryCandidates(b, a)).toBeLessThan(0);
    a.ranking.priority = 'p2';
    a.axes.timing = { milliPoints: 16_000, band: 'warm', hasSupportedTrigger: true };
    b.ranking.earliestTriggerExpiresAt = '2026-09-07T00:00:00.000Z';
    expect(compareDiscoveryCandidates(b, a)).toBeLessThan(0);
  });

  it('orders exploration by newest supported observation, never-contacted then oldest conversation, then Person ID', () => {
    const a = assessment('a', true);
    const b = assessment('b', true);
    a.prospectId = 'z-prospect';
    b.prospectId = 'a-prospect';
    expect(compareDiscoveryCandidates(a, b)).toBeLessThan(0);
    a.ranking.latestSourceObservedAt = null;
    expect(compareDiscoveryCandidates(b, a)).toBeLessThan(0);
    a.ranking.latestSourceObservedAt = b.ranking.latestSourceObservedAt;
    a.ranking.lastContactAt = '2026-09-05T11:00:00.000Z';
    expect(compareDiscoveryCandidates(b, a)).toBeLessThan(0);
    b.ranking.lastContactAt = '2026-09-06T11:00:00.000Z';
    expect(compareDiscoveryCandidates(a, b)).toBeLessThan(0);
    b.ranking.latestSourceObservedAt = AS_OF;
    expect(compareDiscoveryCandidates(b, a)).toBeLessThan(0);
    expect(compareDiscoveryCandidates(a, a)).toBe(0);
  });

  it('reserves two of ten places, fills unused reservations from primary and caps exploration-only output', () => {
    const primary = Array.from({ length: 12 }, (_, i) => assessment(`p${String(i).padStart(2, '0')}`));
    const exploration = ['e1', 'e2', 'e3'].map(id => assessment(id, true));
    expect(selectDiscoveryCandidates({ assessments: [...exploration, ...primary], limit: 100 }).map(a => a.personId))
      .toEqual(['p00', 'p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'e1', 'e2']);
    expect(selectDiscoveryCandidates({ assessments: primary, limit: 10 })).toHaveLength(10);
    expect(selectDiscoveryCandidates({ assessments: [...primary, exploration[0]!], limit: 10 }).map(a => a.personId))
      .toEqual(['p00', 'p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'e1']);
    expect(selectDiscoveryCandidates({ assessments: exploration, limit: 10 }).map(a => a.personId)).toEqual(['e1', 'e2']);
  });

  it('prefers primary at capacity one, handles bounded integer capacity and never promotes other dispositions', () => {
    const input = [assessment('e', true), assessment('p')];
    expect(selectDiscoveryCandidates({ assessments: input, limit: 1 }).map(a => a.personId)).toEqual(['p']);
    expect(selectDiscoveryCandidates({ assessments: input, limit: 0 })).toEqual([]);
    for (const limit of [-1, 1.5, NaN, Infinity]) expect(() => selectDiscoveryCandidates({ assessments: input, limit })).toThrow();
    const others = ['watch', 'research', 'judgment', 'excluded'].map(disposition => ({ ...assessment(disposition), disposition, ranking: { ...assessment(disposition).ranking, priority: null } } as DiscoveryAssessment));
    expect(selectDiscoveryCandidates({ assessments: others, limit: 10 })).toEqual([]);
  });

  it('deduplicates Persons before allocating, keeps primary over exploration and never mutates inputs', () => {
    const duplicate = assessment('same', true);
    const primary = assessment('same');
    primary.salesCycleId = 'preferred-cycle';
    const values = freeze([duplicate, assessment('e2', true), primary, assessment('p2'), assessment('e3', true)]);
    const before = JSON.stringify(values);
    const result = selectDiscoveryCandidates({ assessments: values, limit: 10 });
    expect(result.map(a => a.personId)).toEqual(['p2', 'same', 'e2', 'e3']);
    expect(result.find(a => a.personId === 'same')?.salesCycleId).toBe('preferred-cycle');
    expect(selectDiscoveryCandidates({ assessments: [...values].reverse(), limit: 10 })).toEqual(result);
    expect(JSON.stringify(values)).toBe(before);
  });
});
