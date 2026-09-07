import type { AppDatabase } from '../../db/database';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import { revalidateDiscoverySnapshot, type DiscoveryEvidenceServices } from './discoveryEvidence';
import type { DiscoveryEvidenceSnapshot } from './discoveryTypes';

/** Only collector-admitted facts. No qualification, relationship, profile or verification invention. */
export class DiscoveryFactWriter {
  constructor(private readonly input: { database: AppDatabase; unitOfWork: DomainUnitOfWork; services: DiscoveryEvidenceServices }) {
    const { database, unitOfWork, services } = input;
    services.identities.assertBoundTo(database, unitOfWork);
    services.sourceRepository.assertBoundTo(database, unitOfWork);
    services.events.assertBoundTo(database, unitOfWork);
    services.prioritizationRepository.assertBoundTo(database, unitOfWork);
    services.outboundPermission.assertBoundTo(database, unitOfWork);
    services.workspaceSettings.assertBoundTo(database, unitOfWork);
  }

  apply(snapshot: DiscoveryEvidenceSnapshot): void {
    const { database, unitOfWork, services } = this.input;
    unitOfWork.assertWriteScope();
    revalidateDiscoverySnapshot(snapshot, database, services);
    if (snapshot.conflicts.length || snapshot.unresolvedIdentity || !snapshot.identitySupported
      || snapshot.operationallyBlocked || snapshot.workflowStatus !== 'active'
      || snapshot.qualificationState === 'disqualified' || snapshot.qualificationState === 'merge_review') return;
    const current = services.identities.listPropertiesForProspect(snapshot.prospectId);
    for (const fact of snapshot.properties) {
      if (fact.doorCount !== null && current.some(p => p.id === fact.id && p.doorCount === null)) {
        services.identities.fillMissingPropertyDoorCount({ prospectId: snapshot.prospectId, propertyId: fact.id, doorCount: fact.doorCount });
      }
    }
    for (const trigger of snapshot.triggers) {
      if (services.prioritizationRepository.getTriggerEventById(trigger.id) !== null) continue;
      const [firstRef, ...otherRefs] = trigger.evidence.evidenceRefs;
      if (firstRef === undefined) throw new Error('Admitted trigger requires evidence.');
      services.prioritization.scopedWriter().recordTriggerEvent({ id: trigger.id, prospectId: snapshot.prospectId,
        triggerType: trigger.triggerType, effectiveAt: trigger.effectiveAt, sourceExpiresAt: trigger.expiresAt,
        strengthMultiplier: trigger.strengthMultiplier, verificationState: trigger.verificationState, evidence: { ...trigger.evidence, evidenceRefs: [firstRef, ...otherRefs] } });
    }
  }
}
