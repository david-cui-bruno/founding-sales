import type { DiscoveryAssessment, DiscoveryClaim, DiscoveryDisposition } from '../../../shared/contracts/discoveryContract';
import { calculateConfidence, calculateFit, deriveReachability, parseCanonicalUtcMillis } from '../prioritization/qualificationEngine';
import { compareProspectPriority } from '../prioritization/priorityOrdering';
import { resolvePriorityMatrix } from '../prioritization/priorityMatrix';
import { evaluateTriggers } from '../prioritization/triggerMath';
import type { OrderablePriorityRow, PropertyFact, TriggerEvent } from '../prioritization/prioritizationTypes';
import { PrioritizationInputCorruptionError } from '../support/domainErrors';
import { buildDiscoveryQuestions } from './discoveryBrief';
import type { DiscoveryAssessmentDraft, DiscoveryEvaluationInput, DiscoveryEvidenceSnapshot } from './discoveryTypes';

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** These are collector-admitted facts, never claims inferred from names/labels. */
function hasScoreablePropertyFacts(properties: readonly PropertyFact[]): boolean {
  return properties.some(property => property.doorCount !== null || property.verifiedAt !== null
    || (property.maintenanceProfile !== null && (property.maintenanceProfile.management !== 'unknown'
      || property.maintenanceProfile.relevantProfile !== 'unknown')));
}

function fitUnknowns(properties: readonly PropertyFact[]): string[] {
  const unknowns: string[] = [];
  if (properties.length === 0 || properties.some(property => property.doorCount === null)) {
    unknowns.push('Door count is not fully established');
  }
  if (!properties.some(property => property.maintenanceProfile !== null
    && property.maintenanceProfile.management !== 'unknown')) unknowns.push('Management style is unknown');
  if (properties.length === 0 || properties.some(property => property.verifiedAt === null
    || !property.countryCode.trim() || !property.region.trim() || !property.locality.trim())) {
    unknowns.push('Verified route density is not fully established');
  }
  if (!properties.some(property => property.maintenanceProfile !== null
    && property.maintenanceProfile.relevantProfile !== 'unknown')) unknowns.push('Relevant maintenance profile is unknown');
  return unknowns;
}

function latestSupportedObservation(snapshot: DiscoveryEvidenceSnapshot): string | null {
  const times = snapshot.validatedClaims.flatMap(claim => claim.refs.map(ref => ref.observedAt));
  if (snapshot.originalSource.evidenceRef?.trim()) times.push(snapshot.originalSource.observedAt);
  return times.length === 0 ? null : times.sort(compareText)[times.length - 1]!;
}

function assertEvidenceAsOf(snapshot: DiscoveryEvidenceSnapshot, asOf: string): void {
  const instants = [snapshot.originalSource.observedAt,
    ...snapshot.validatedClaims.flatMap(claim => claim.refs.map(ref => ref.observedAt)),
    ...snapshot.claims.flatMap(claim => claim.refs.map(ref => ref.observedAt))];
  if (snapshot.lastConversationAt !== null) instants.push(snapshot.lastConversationAt);
  for (const instant of instants) {
    parseCanonicalUtcMillis(instant, 'Discovery evidence observation');
    if (instant > asOf) throw new PrioritizationInputCorruptionError('Discovery evidence cannot be in the future.');
  }
}

/** Conflicting full-evidence claims take display precedence over ordinary claims. */
function presentationClaims(snapshot: DiscoveryEvidenceSnapshot): DiscoveryClaim[] {
  const conflictIds = new Set(snapshot.conflicts.flatMap(conflict => [...conflict.claimIds]));
  const conflicts = snapshot.validatedClaims.filter(claim => conflictIds.has(claim.id))
    .sort((a, b) => compareText(a.id, b.id));
  const ordinary = [...snapshot.claims].sort((a, b) => compareText(a.id, b.id));
  const seen = new Set<string>();
  return [...conflicts, ...ordinary].filter(claim => {
    if (seen.has(claim.id)) return false;
    seen.add(claim.id);
    return true;
  }).slice(0, 100).map(claim => ({ ...claim, refs: claim.refs.slice(0, 20).map(ref => ({ ...ref })) }));
}

function baseDraft(snapshot: DiscoveryEvidenceSnapshot, disposition: DiscoveryDisposition,
  reasonCodes: string[]): DiscoveryAssessmentDraft {
  return {
    personId: snapshot.personId, prospectId: snapshot.prospectId, salesCycleId: snapshot.salesCycleId,
    fingerprint: snapshot.inputFingerprint, policyVersion: 'discovery-v1', ruleVersionId: snapshot.ruleVersionId,
    disposition, reasonCodes, identitySupported: snapshot.identitySupported, needsResearch: disposition === 'research',
    axes: { fit: null, timing: { milliPoints: 0, band: 'cold', hasSupportedTrigger: false }, reachability: deriveReachability(snapshot.contacts) },
    claims: presentationClaims(snapshot), unknowns: ['No current trigger established'],
    questions: buildDiscoveryQuestions(snapshot),
    ranking: { priority: null, earliestTriggerExpiresAt: null, dataConfidence: 0,
      lastContactAt: snapshot.lastConversationAt, latestSourceObservedAt: latestSupportedObservation(snapshot) },
  };
}
function excludedDraft(snapshot: DiscoveryEvidenceSnapshot, reason: string): DiscoveryAssessmentDraft {
  return baseDraft(snapshot, 'excluded', [reason]);
}
function judgmentDraft(snapshot: DiscoveryEvidenceSnapshot, reasons: string[]): DiscoveryAssessmentDraft {
  return baseDraft(snapshot, 'judgment', reasons);
}
function researchDraft(snapshot: DiscoveryEvidenceSnapshot, reason: string): DiscoveryAssessmentDraft {
  const draft = baseDraft(snapshot, 'research', [reason]);
  draft.unknowns.push(reason === 'owner_identity_unknown' ? 'Owner identity is not established' : 'Linked property context is unknown');
  return draft;
}

/** Cheap tuple coherence, NOT source/receipt existence or value validation. */
function coherentTrigger(event: TriggerEvent, snapshot: DiscoveryEvidenceSnapshot): boolean {
  if (event.prospectId !== snapshot.prospectId || event.evidence.triggerType !== event.triggerType
    || !event.evidence.evidenceRefs.some(ref => ref.trim().length > 0)) return false;
  const proof = event.evidence.proof;
  if (proof.kind === 'source_event') {
    return event.sourceEventId !== null && event.sourceEventId === proof.sourceEventId
      && event.reactivationReceiptActivationKey === null && event.reactivationRuleId === null
      && event.triggerType !== 'nurture_resurrection';
  }
  return event.sourceEventId === null && event.triggerType === 'nurture_resurrection'
    && event.reactivationReceiptActivationKey === proof.activationKey
    && event.reactivationRuleId === proof.ruleId && proof.newCycleId === snapshot.salesCycleId;
}

/** Advisory assessment only. Does not qualify, authorize, write, or read a clock. */
export function evaluateDiscovery(input: DiscoveryEvaluationInput): DiscoveryAssessmentDraft {
  const { snapshot, rule, asOf } = input;
  parseCanonicalUtcMillis(asOf, 'Discovery asOf');
  if (snapshot.ruleVersionId !== rule.id) {
    throw new PrioritizationInputCorruptionError('Discovery rule ID does not match the admitted snapshot.');
  }
  assertEvidenceAsOf(snapshot, asOf);
  if (snapshot.workflowStatus !== 'active' || snapshot.operationallyBlocked
    || snapshot.qualificationState === 'disqualified') {
    return excludedDraft(snapshot, 'existing_operational_or_qualification_block');
  }
  const conflicts = new Set(snapshot.conflicts.map(conflict => `${conflict.kind}_conflict`));
  if (snapshot.qualificationState === 'merge_review') conflicts.add('identity_conflict');
  if (conflicts.size > 0) return judgmentDraft(snapshot, [...conflicts].sort(compareText));
  if (snapshot.unresolvedIdentity || !snapshot.identitySupported) {
    return researchDraft(snapshot, 'owner_identity_unknown');
  }
  if (snapshot.properties.length === 0) return researchDraft(snapshot, 'property_context_unknown');

  const fit = hasScoreablePropertyFacts(snapshot.properties)
    ? calculateFit({ properties: snapshot.properties, rule }) : null;
  const unknowns = fitUnknowns(snapshot.properties);
  const timing = evaluateTriggers({ events: snapshot.triggers.filter(event => coherentTrigger(event, snapshot)), rule, evaluatedAt: asOf });
  const reachability = deriveReachability(snapshot.contacts);
  const primary = fit !== null && fit.fitBand !== 'low';
  const incomplete = unknowns.length > 0;
  const draft = baseDraft(snapshot, primary || incomplete ? 'candidate' : 'watch',
    [primary ? 'supported_property_primary' : incomplete ? 'supported_property_exploration' : 'known_fit_below_primary']);
  draft.axes = {
    fit: fit === null ? null : { points: fit.fitPoints, band: fit.fitBand, completeness: incomplete ? 'partial' : 'complete' },
    timing: { milliPoints: timing.timingMilliPoints, band: timing.timingBand, hasSupportedTrigger: timing.selectedKeys.length > 0 },
    reachability,
  };
  draft.unknowns = unknowns;
  if (timing.selectedKeys.length === 0) draft.unknowns.push('No current trigger established');
  if (reachability === 'none') draft.unknowns.push('No usable contact method established');
  draft.unknowns.push('Maintenance pain and willingness to pay are not established by property ownership');
  draft.ranking = {
    priority: primary ? resolvePriorityMatrix({ fitBand: fit.fitBand, timingBand: timing.timingBand,
      reachability, selectedPositiveTriggerKeys: timing.selectedKeys }).priority : null,
    earliestTriggerExpiresAt: timing.earliestTriggerExpiresAt,
    dataConfidence: calculateConfidence({ snapshot: { originalSource: snapshot.originalSource,
      properties: snapshot.properties, contactMethods: snapshot.contacts }, evaluatedAt: asOf, rule }).dataConfidence,
    lastContactAt: snapshot.lastConversationAt, latestSourceObservedAt: latestSupportedObservation(snapshot),
  };
  if (snapshot.resurfaceAt !== null) {
    parseCanonicalUtcMillis(snapshot.resurfaceAt, 'Discovery resurfaceAt');
    if (snapshot.resurfaceAt > asOf) {
      draft.disposition = 'watch';
      draft.reasonCodes = ['existing_resurface_in_future'];
      draft.ranking.priority = null;
    }
  }
  return draft;
}

function isPrimary(assessment: DiscoveryAssessment): boolean {
  return assessment.disposition === 'candidate' && assessment.identitySupported
    && assessment.axes.fit !== null && assessment.axes.fit.band !== 'low' && assessment.ranking.priority !== null;
}
function isExploration(assessment: DiscoveryAssessment): boolean {
  return assessment.disposition === 'candidate' && assessment.identitySupported
    && assessment.ranking.priority === null && (assessment.axes.fit === null
      || (assessment.axes.fit.band === 'low' && assessment.axes.fit.completeness === 'partial'));
}
function orderable(assessment: DiscoveryAssessment): OrderablePriorityRow {
  if (!isPrimary(assessment)) throw new PrioritizationInputCorruptionError('Only primary discovery candidates have local priority inputs.');
  return {
    prospectId: assessment.prospectId, effectivePriority: assessment.ranking.priority!,
    earliestTriggerExpiresAt: assessment.ranking.earliestTriggerExpiresAt,
    timingMilliPoints: assessment.axes.timing.milliPoints, fitPoints: assessment.axes.fit!.points,
    reachability: assessment.axes.reachability, dataConfidence: assessment.ranking.dataConfidence,
    lastContactAt: assessment.ranking.lastContactAt, cloudSourcePercentile: null, cloudTiming: null,
  };
}
function compareObservation(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareText(b, a);
}
function compareConversation(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareText(a, b);
}

export function compareDiscoveryCandidates(a: DiscoveryAssessment, b: DiscoveryAssessment): number {
  const aPrimary = isPrimary(a);
  const bPrimary = isPrimary(b);
  if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
  if (aPrimary && bPrimary) return compareProspectPriority(orderable(a), orderable(b));
  return compareObservation(a.ranking.latestSourceObservedAt, b.ranking.latestSourceObservedAt)
    || compareConversation(a.ranking.lastContactAt, b.ranking.lastContactAt)
    || compareText(a.personId, b.personId);
}

/** Current/fresh assessments are supplied by the read service. No capacity I/O. */
export function selectDiscoveryCandidates(input: {
  assessments: readonly DiscoveryAssessment[]; limit: number;
}): DiscoveryAssessment[] {
  if (!Number.isSafeInteger(input.limit) || input.limit < 0) {
    throw new RangeError('Discovery capacity must be a non-negative safe integer.');
  }
  const limit = Math.min(10, input.limit);
  if (limit === 0) return [];
  const sorted = input.assessments.filter(value => isPrimary(value) || isExploration(value))
    .sort((a, b) => compareDiscoveryCandidates(a, b) || compareText(a.id, b.id));
  const people = new Set<string>();
  const unique = sorted.filter(value => {
    if (people.has(value.personId)) return false;
    people.add(value.personId);
    return true;
  });
  const primary = unique.filter(isPrimary);
  const exploration = unique.filter(isExploration);
  if (limit === 1) return primary.length > 0 ? primary.slice(0, 1) : exploration.slice(0, 1);
  const explorationCount = Math.min(2, exploration.length, limit);
  return [...primary.slice(0, limit - explorationCount), ...exploration.slice(0, explorationCount)];
}
