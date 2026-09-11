import { describe, expect, it } from 'vitest';

import {
  beginDiscoveryReceiptSchema, beginDiscoveryRequestSchema, discoveryAssessmentSchema,
  discoveryAxesSchema, discoveryBriefRequestSchema, discoveryBriefSchema,
  discoveryClaimSchema, discoveryEvidenceRefSchema, discoveryOverrideSchema,
  discoverySnapshotSchema, overrideDiscoveryRequestSchema,
} from '../../src/shared/contracts/discoveryContract';
import type { DiscoveryAssessment, DiscoveryAxes, DiscoveryBrief, DiscoverySnapshot } from '../../src/shared/contracts/discoveryContract';
import { evaluateDiscovery } from '../../src/main/domain/discovery/discoveryPolicy';
import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import { evidence } from '../fixtures/discoveryEvidence';

const ID = '11111111-1111-4111-8111-111111111111';
const AS_OF = '2026-09-06T12:00:00.000Z';
function stored(): DiscoveryAssessment {
  return {
    ...evaluateDiscovery({ snapshot: evidence(), rule: BUILTIN_PRIORITIZATION_RULE_V1, asOf: AS_OF }),
    id: ID, modelVersion: null, evaluatedAt: AS_OF, expiresAt: '2026-09-07T04:00:00.000Z',
    localDate: '2026-09-06', overrideId: null,
  };
}
function brief(): DiscoveryBrief {
  return {
    personId: 'person-1', salesCycleId: 'cycle-1', personName: 'Morgan Property LLC',
    assessment: stored(), stale: false, latestOverride: null, pilotNextStep: null,
  };
}
const request = {
  commandId: ID, personId: 'person-1', salesCycleId: 'cycle-1', assessmentId: ID,
  expectedFingerprint: 'a'.repeat(64),
};

describe('discovery contracts', () => {
  it('accepts real policy output with writer metadata and reports cloud Fit at the exact axis path', () => {
    const value = stored();
    expect(discoveryAssessmentSchema.safeParse(value).success).toBe(true);
    const invalid = discoveryAssessmentSchema.safeParse({ ...value, axes: { ...value.axes,
      fit: { points: 100, band: 'high', completeness: 'complete' },
    } });
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.error.issues.map(i => i.path.join('.'))).toContain('axes.fit.points');
  });

  it('preserves null Fit versus actual zero and rejects mismatched bands and Timing units', () => {
    const axes: DiscoveryAxes = { fit: null, timing: { milliPoints: 0, band: 'cold', hasSupportedTrigger: false }, reachability: 'none' };
    expect(discoveryAxesSchema.parse(axes).fit).toBeNull();
    expect(discoveryAxesSchema.parse({ ...axes, fit: { points: 0, band: 'low', completeness: 'partial' } }).fit?.points).toBe(0);
    for (const fit of [
      { points: 15, band: 'high', completeness: 'partial' },
      { points: 15.5, band: 'medium', completeness: 'complete' },
      { points: Infinity, band: 'high', completeness: 'complete' },
    ]) expect(discoveryAxesSchema.safeParse({ ...axes, fit }).success).toBe(false);
    for (const timing of [
      { milliPoints: 8_000, band: 'cold', hasSupportedTrigger: true },
      { milliPoints: 40_001, band: 'hot', hasSupportedTrigger: true },
      { milliPoints: 30, band: 'hot', hasSupportedTrigger: true },
      { milliPoints: 1_000.5, band: 'cold', hasSupportedTrigger: true },
      { milliPoints: 0, band: 'cold', hasSupportedTrigger: true },
      { milliPoints: 8_000, band: 'warm', hasSupportedTrigger: false },
    ]) expect(discoveryAxesSchema.safeParse({ ...axes, timing }).success).toBe(false);
    expect(discoveryAxesSchema.safeParse({ ...axes, timing: { milliPoints: 40_000, band: 'hot', hasSupportedTrigger: true } }).success).toBe(true);
  });

  it('requires fact references and strict kind-specific citations without promoting inference', () => {
    const source = evidence().claims[0]!;
    expect(discoveryClaimSchema.safeParse(source).success).toBe(true);
    expect(discoveryClaimSchema.safeParse({ ...source, refs: [] }).success).toBe(false);
    expect(discoveryClaimSchema.parse({ ...source, certainty: 'inference', refs: [] }).certainty).toBe('inference');
    expect(discoveryEvidenceRefSchema.safeParse({ kind: 'activity', activityId: 'activity-1', field: 'note', observedAt: AS_OF }).success).toBe(true);
    const utterance = { kind: 'utterance', activityId: 'activity-1', transcriptId: 'transcript-1', utteranceId: 'utterance-1', quote: 'We handle maintenance ourselves.', observedAt: AS_OF };
    expect(discoveryEvidenceRefSchema.safeParse(utterance).success).toBe(true);
    expect(discoveryEvidenceRefSchema.safeParse({ ...utterance, quote: '' }).success).toBe(false);
    expect(discoveryEvidenceRefSchema.safeParse({ ...utterance, sourceEventId: 'source-1' }).success).toBe(false);
    expect(discoveryClaimSchema.safeParse({ ...source, refs: Array(21).fill(source.refs[0]) }).success).toBe(false);
  });

  it('rejects noncanonical IDs, fingerprints, dates, timestamps and inconsistent time ordering', () => {
    const value = stored();
    for (const changes of [
      { id: 'assessment-1' }, { overrideId: 'override-1' }, { personId: ' person-1 ' },
      { salesCycleId: '' }, { fingerprint: 'A'.repeat(64) }, { fingerprint: 'a'.repeat(63) },
      { evaluatedAt: '2026-09-06T12:00:00Z' }, { evaluatedAt: '2026-09-06T08:00:00.000-04:00' },
      { evaluatedAt: '2026-02-30T12:00:00.000Z' }, { localDate: '2026-02-30' },
      { expiresAt: AS_OF }, { expiresAt: '2026-09-05T12:00:00.000Z' },
      { ranking: { ...value.ranking, lastContactAt: '2026-09-08T12:00:00.000Z' } },
      { ranking: { ...value.ranking, latestSourceObservedAt: '2026-09-08T12:00:00.000Z' } },
    ]) expect(discoveryAssessmentSchema.safeParse({ ...value, ...changes }).success, JSON.stringify(changes)).toBe(false);
    expect(discoveryAssessmentSchema.safeParse({ ...value, localDate: '2024-02-29' }).success).toBe(true);
  });

  it('rejects incoherent candidate identity, provisional priority and unsupported extra fields', () => {
    const value = stored();
    for (const changes of [
      { identitySupported: false }, { axes: { ...value.axes, fit: null as null } },
      { disposition: 'research' }, { overallScore: 99 },
      { ranking: { ...value.ranking, cloudTiming: 100 } },
      { ranking: { ...value.ranking, dataConfidence: 11 } },
      { axes: { ...value.axes, outboundAuthorized: true } },
      { claims: [{ ...value.claims[0]!, refs: [{ ...value.claims[0]!.refs[0]!, observedAt: '2026-09-08T12:00:00.000Z' }] }] },
    ]) expect(discoveryAssessmentSchema.safeParse({ ...value, ...changes }).success).toBe(false);
  });

  it('bounds presentation collections and rejects contradictory brief ownership and fabricated pilot evidence', () => {
    const value = stored();
    for (const changes of [
      { claims: Array(101).fill(value.claims[0]) }, { questions: Array(4).fill('Question?') },
      { reasonCodes: Array(51).fill('reason') }, { unknowns: Array(51).fill('Unknown') },
    ]) expect(discoveryAssessmentSchema.safeParse({ ...value, ...changes }).success).toBe(false);
    expect(discoveryBriefSchema.safeParse(brief()).success).toBe(true);
    expect(discoveryBriefSchema.safeParse({ ...brief(), assessment: null }).success).toBe(true);
    expect(discoveryBriefSchema.safeParse({ ...brief(), personId: 'someone-else' }).success).toBe(false);
    expect(discoveryBriefSchema.safeParse({ ...brief(), salesCycleId: 'another-cycle' }).success).toBe(false);
    expect(discoveryBriefSchema.safeParse({ ...brief(), pilotNextStep: { label: 'Try a pilot', activityIds: [] } }).success).toBe(false);
    expect(discoveryBriefSchema.safeParse({ ...brief(), pilotNextStep: { label: 'Discuss a pilot', activityIds: ['activity-1'] } }).success).toBe(true);
    const snapshot: DiscoverySnapshot = { prepared: [brief()], judgment: [], counts: { unassessed: 0, research: 0, watch: 0, excluded: 0 }, processing: 'idle', researchCapability: 'not_configured', generatedAt: AS_OF, revision: 0 };
    expect(discoverySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(discoverySnapshotSchema.safeParse({ ...snapshot, prepared: Array(11).fill(brief()) }).success).toBe(false);
    expect(discoverySnapshotSchema.safeParse({ ...snapshot, judgment: Array(21).fill(brief()) }).success).toBe(false);
    expect(discoverySnapshotSchema.safeParse({ ...snapshot, counts: { ...snapshot.counts, research: -1 } }).success).toBe(false);
  });

  it('validates all public request/receipt/override DTOs and rejects hidden authority', () => {
    expect(discoveryBriefRequestSchema.safeParse({ personId: 'person-1' }).success).toBe(true);
    expect(discoveryBriefRequestSchema.safeParse({ personId: 'person-1', prepare: true }).success).toBe(false);
    expect(beginDiscoveryRequestSchema.safeParse(request).success).toBe(true);
    expect(beginDiscoveryRequestSchema.safeParse({ ...request, commandId: 'command-1' }).success).toBe(false);
    expect(beginDiscoveryRequestSchema.safeParse({ ...request, authorizeOutbound: true }).success).toBe(false);
    const override = { commandId: ID, personId: 'person-1', assessmentId: ID, expectedFingerprint: 'a'.repeat(64), decision: 'watch', reason: 'Wait for more evidence' };
    expect(overrideDiscoveryRequestSchema.safeParse(override).success).toBe(true);
    expect(overrideDiscoveryRequestSchema.safeParse({ ...override, reason: '   ' }).success).toBe(false);
    expect(overrideDiscoveryRequestSchema.safeParse({ ...override, decision: 'disqualify' }).success).toBe(false);
    expect(discoveryOverrideSchema.safeParse({ id: ID, assessmentId: ID, decision: 'reconsider', reason: 'New evidence', createdAt: AS_OF, evidenceChanged: false }).success).toBe(true);
    const receipt = { mutation: { revision: 1, affectedPersonIds: ['person-1'], affectedSalesCycleIds: ['cycle-1'] }, personId: 'person-1', salesCycleId: 'cycle-1', assessmentId: ID, actionId: 'action-1' };
    expect(beginDiscoveryReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(beginDiscoveryReceiptSchema.safeParse({ ...receipt, personId: 'someone-else' }).success).toBe(false);
    expect(beginDiscoveryReceiptSchema.safeParse({ ...receipt, mutation: { ...receipt.mutation, send: true } }).success).toBe(false);
  });

  it('does not accept a snapshot generated before its assessment or override existed', () => {
    const snapshot: DiscoverySnapshot = { prepared: [brief()], judgment: [],
      counts: { unassessed: 0, research: 0, watch: 0, excluded: 0 }, processing: 'idle',
      researchCapability: 'not_configured', generatedAt: '2026-09-06T11:00:00.000Z', revision: 0 };
    expect(discoverySnapshotSchema.safeParse(snapshot).success).toBe(false);
    snapshot.generatedAt = AS_OF;
    snapshot.prepared[0]!.latestOverride = { id: ID, assessmentId: ID, decision: 'watch',
      reason: 'Later founder decision', createdAt: '2026-09-07T12:00:00.000Z', evidenceChanged: true };
    expect(discoverySnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});
