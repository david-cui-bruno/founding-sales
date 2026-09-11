import type { DiscoveryEvidenceSnapshot } from './discoveryTypes';
import type { Activity } from '../events/eventTypes';
import type { DiscoveryBrief } from '../../../shared/contracts/discoveryContract';

/** Questions only. Evaluation/writer timestamps date the containing assessment. */
export function buildDiscoveryQuestions(snapshot: DiscoveryEvidenceSnapshot): string[] {
  if (snapshot.operationallyBlocked || snapshot.workflowStatus !== 'active'
    || snapshot.qualificationState === 'disqualified') return [];
  if (snapshot.qualificationState === 'merge_review' || snapshot.conflicts.length > 0) {
    return ['Which source establishes the current owner and linked property?'];
  }
  if (snapshot.unresolvedIdentity || !snapshot.identitySupported) {
    return ['Who owns the property and who handles its maintenance decisions?'];
  }
  const knownManagement = snapshot.properties.some(property => property.maintenanceProfile !== null
    && property.maintenanceProfile.management !== 'unknown');
  const unknownUnits = snapshot.properties.length === 0
    || snapshot.properties.some(property => property.doorCount === null);
  return [
    knownManagement
      ? 'How is maintenance coordinated today, and what, if anything, would you change?'
      : 'Do you handle maintenance yourself or use a property manager?',
    unknownUnits
      ? 'How many rental units are you responsible for?'
      : 'What, if anything, is difficult about arranging maintenance for your properties?',
    'Callie has a US-wide product proposition, with stronger delivery evidence in Texas. Where are your properties, and what local coverage would you need?',
  ];
}

/** Advisory language only. The caller supplies current, collector-admitted evidence.
 * All-cycle conversation history is useful context, but never current buyer intent.
 */
export function buildDiscoveryPilotNextStep(input: {
  snapshot: DiscoveryEvidenceSnapshot;
  activities: readonly Activity[];
  followUp: { id: string; actionType: string; createdAt: string } | null;
}): DiscoveryBrief['pilotNextStep'] {
  const { snapshot, followUp } = input;
  if (snapshot.operationallyBlocked || snapshot.workflowStatus !== 'active'
    || snapshot.qualificationState === 'disqualified' || snapshot.conflicts.length > 0) return null;
  const activities = input.activities.filter(a => a.personId === snapshot.personId
    && a.salesCycleId === snapshot.salesCycleId && snapshot.conversationActivityIds.includes(a.id));
  if (activities.length === 0) return null;
  const activityIds = activities.map(a => a.id).sort().slice(0, 100);
  if (snapshot.stage === 'contacted') return { label: 'Suggest a discovery conversation', activityIds };
  if (snapshot.stage === 'interviewed') {
    // This is the collector's explicit, property-attributed management statement,
    // not a keyword match, heuristic self-managed flag, price, pain, or payment claim.
    const relevant = snapshot.validatedClaims.filter(c => c.label.startsWith('Management at ')
      && (c.value === 'self_managed' || c.value === 'third_party'))
      .flatMap(c => c.refs.filter(r => r.kind === 'utterance' && activityIds.includes(r.activityId)))
      .map(r => r.kind === 'utterance' ? r.activityId : '');
    if (relevant.length === 0) return null;
    return { label: 'Discuss whether a supervised trial would be useful', activityIds: [...new Set(relevant)].sort().slice(0, 100) };
  }
  if (snapshot.stage === 'offered' && followUp !== null) {
    const action = followUp.actionType.replaceAll('_', ' ');
    return { label: `Existing ${action} (recorded ${followUp.createdAt})`,
      activityIds };
  }
  return null;
}
