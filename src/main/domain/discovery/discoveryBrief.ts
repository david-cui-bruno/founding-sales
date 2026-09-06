import type { DiscoveryEvidenceSnapshot } from './discoveryTypes';

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
