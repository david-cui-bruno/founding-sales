import { z } from 'zod';
import { mutationReceiptSchema, type MutationReceipt } from '../../../shared/contracts/commonContract';
import { beginDiscoveryRequestSchema, beginDiscoveryReceiptSchema, discoveryAssessmentSchema, overrideDiscoveryRequestSchema,
  type BeginDiscoveryRequest, type BeginDiscoveryReceipt, type DiscoverySnapshot, type DiscoveryBrief,
  type DiscoveryAssessment, type OverrideDiscoveryRequest } from '../../../shared/contracts/discoveryContract';
import type { AppDatabase } from '../../db/database';
import type { DomainServices } from '../createDomainServices';
import type { Clock } from '../support/clock';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import type { IdGenerator } from '../support/idGenerator';
import { resolveLocalDayInterval } from '../today/todayOrdering';
import { collectDiscoveryEvidence, validateDiscoveryClaim } from './discoveryEvidence';
import type { DiscoveryFactWriter } from './discoveryFactWriter';
import { evaluateDiscovery } from './discoveryPolicy';
import type { DiscoveryEvidenceSnapshot, DiscoveryProcessResult } from './discoveryTypes';

type Services = Pick<DomainServices, 'identities' | 'sourceRepository' | 'events' | 'outboundPermission' |
  'prioritizationRepository' | 'prioritization' | 'lifecycle' | 'workspaceSettings' | 'discoveryRepository' | 'discoveryRead'>;
type Dependencies = { database: AppDatabase; unitOfWork: DomainUnitOfWork;
  services: Services; factWriter: DiscoveryFactWriter; clock: Clock; ids: IdGenerator };

/** Local assessment and selected preparation only. No provider, contact or outreach capability. */
export class DiscoveryService {
  private readonly input: Dependencies;

  constructor(input: Dependencies) {
    const { database, unitOfWork, services, factWriter } = input;
    if (database !== unitOfWork.database) throw new DomainRepositoryDatabaseMismatchError();
    for (const bound of [services.identities, services.sourceRepository, services.events, services.outboundPermission,
      services.prioritizationRepository, services.lifecycle, services.workspaceSettings, services.discoveryRepository]) {
      bound.assertBoundTo(database, unitOfWork);
    }
    services.prioritization.assertBoundTo(database, unitOfWork, services);
    services.discoveryRead.assertBoundTo(database, unitOfWork, services);
    factWriter.assertBoundTo(database, unitOfWork, services);
    this.input = { ...input, services: { ...services } };
  }

  get(): DiscoverySnapshot { return this.input.services.discoveryRead.get(); }
  getBrief(personId: string): DiscoveryBrief { return this.input.services.discoveryRead.getBrief(personId); }

  assess(prospectId: string): DiscoveryProcessResult {
    const id = discoveryAssessmentSchema.shape.prospectId.parse(prospectId);
    const { unitOfWork, clock, factWriter, services, ids } = this.input;
    return unitOfWork.immediate(() => {
      const asOf = clock.now();
      factWriter.apply(this.collect(id, asOf));
      // Canonical repairs change the fingerprint. Persist only recollected evidence.
      const evidence = this.collect(id, asOf);
      const current = services.discoveryRepository.getCurrent(id);
      if (current !== null && this.isCurrent(current, evidence, asOf)) return { assessmentId: current.id, unchanged: true };
      const rule = services.prioritizationRepository.getActiveRuleVersion();
      if (rule === null) throw new Error('DISCOVERY_ACTIVE_RULE_REQUIRED');
      const draft = evaluateDiscovery({ snapshot: evidence, rule: rule.document, asOf });
      const day = this.day(asOf);
      const triggerExpiry = draft.ranking.earliestTriggerExpiresAt;
      const expiresAt = triggerExpiry !== null && triggerExpiry > asOf && triggerExpiry < day.localDayEndAt
        ? triggerExpiry : day.localDayEndAt;
      const override = services.discoveryRepository.overrideForFingerprint(id, evidence.inputFingerprint);
      if (override !== null && override.createdAt > asOf) throw new Error('DISCOVERY_FUTURE_OVERRIDE');
      const assessment = discoveryAssessmentSchema.parse({ ...draft, id: ids.next(), modelVersion: null,
        evaluatedAt: asOf, expiresAt, localDate: day.localDate, overrideId: override?.id ?? null });
      services.discoveryRepository.appendAssessment(assessment);
      services.discoveryRepository.setCurrent(id, assessment.id);
      return { assessmentId: assessment.id, unchanged: false };
    });
  }

  begin(input: BeginDiscoveryRequest): BeginDiscoveryReceipt {
    const request = beginDiscoveryRequestSchema.parse(input);
    const { unitOfWork, services, clock, factWriter, ids } = this.input;
    return unitOfWork.immediate(() => {
      const replay = services.discoveryRepository.getPreparation(request.commandId);
      if (replay !== null) {
        if (JSON.stringify(replay.request) !== JSON.stringify(request)) throw new Error('Discovery command conflict.');
        // Historical receipt only. Replay does not re-authorize any action or outreach.
        return replay.receipt;
      }
      const asOf = clock.now();
      const context = services.discoveryRepository.getReadContext(request.personId);
      if (context === null) throw new Error('DISCOVERY_PERSON_NOT_FOUND');
      let evidence = this.collect(context.prospectId, asOf);
      const assessment = this.requireAssessment(request, evidence, asOf);
      this.requireEligible(assessment, evidence, asOf);
      if (services.discoveryRead.remainingCapacityInScope(asOf) <= 0) throw new Error('DISCOVERY_CAPACITY_EXHAUSTED');
      factWriter.apply(evidence);
      evidence = this.collect(evidence.prospectId, asOf);
      this.requireAssessment(request, evidence, asOf);
      const cycle = services.lifecycle.scopedWriter().prepareFromAssessment({ cycleId: evidence.salesCycleId,
        expectedCycleVersion: evidence.cycleVersion, expectedProspectVersion: evidence.prospectVersion,
        effectiveAt: asOf, assessmentId: assessment.id, fingerprint: assessment.fingerprint });
      const projection = services.prioritizationRepository.getProjection(evidence.prospectId);
      const result = services.prioritization.scopedWriter().recalculateProspect({ evaluationId: ids.next(),
        prospectId: evidence.prospectId, ruleVersionId: assessment.ruleVersionId, evaluatedAt: asOf,
        expectedProjectionVersion: projection?.version ?? null });
      if (result.kind !== 'evaluated' || cycle.currentNextActionId === null) throw new Error('DISCOVERY_PREPARATION_INCOMPLETE');
      const receipt = beginDiscoveryReceiptSchema.parse({ mutation: this.receipt(cycle.personId, cycle.id),
        personId: cycle.personId, salesCycleId: cycle.id, assessmentId: assessment.id, actionId: cycle.currentNextActionId });
      services.discoveryRepository.appendPreparation(request, receipt);
      return receipt;
    });
  }

  override(input: OverrideDiscoveryRequest): MutationReceipt {
    const request = overrideDiscoveryRequestSchema.parse(input);
    const { unitOfWork, services, clock, database } = this.input;
    return unitOfWork.immediate(() => {
      const existing = database.raw.prepare('SELECT * FROM discovery_overrides WHERE id = ?').get(request.commandId) as
        { person_id: string; sales_cycle_id: string; assessment_id: string; fingerprint: string; decision: string; reason: string } | undefined;
      if (existing !== undefined) {
        if (existing.person_id !== request.personId || existing.assessment_id !== request.assessmentId
          || existing.fingerprint !== request.expectedFingerprint || existing.decision !== request.decision || existing.reason !== request.reason) {
          throw new Error('Discovery command conflict.');
        }
        return this.receipt(existing.person_id, existing.sales_cycle_id);
      }
      const asOf = clock.now();
      const context = services.discoveryRepository.getReadContext(request.personId);
      if (context === null) throw new Error('DISCOVERY_PERSON_NOT_FOUND');
      const evidence = this.collect(context.prospectId, asOf);
      this.requireAssessment({ ...request, salesCycleId: context.salesCycleId }, evidence, asOf);
      services.discoveryRepository.appendOverride({ ...request, createdAt: asOf });
      return this.receipt(request.personId, context.salesCycleId);
    });
  }

  private collect(prospectId: string, asOf: string): DiscoveryEvidenceSnapshot {
    return collectDiscoveryEvidence({ database: this.input.database, services: this.input.services, prospectId, asOf });
  }

  private day(asOf: string) {
    return resolveLocalDayInterval({ generatedAt: asOf, timezone: this.input.services.workspaceSettings.read().timezone });
  }

  private isCurrent(a: DiscoveryAssessment, evidence: DiscoveryEvidenceSnapshot, asOf: string): boolean {
    const { services } = this.input;
    const override = services.discoveryRepository.overrideForFingerprint(evidence.prospectId, evidence.inputFingerprint);
    return a.personId === evidence.personId && a.prospectId === evidence.prospectId && a.salesCycleId === evidence.salesCycleId
      && a.fingerprint === evidence.inputFingerprint && a.ruleVersionId === evidence.ruleVersionId
      && a.ruleVersionId === services.prioritizationRepository.getActiveRuleVersion()?.id && a.policyVersion === 'discovery-v1'
      && a.localDate === this.day(asOf).localDate && a.overrideId === (override?.id ?? null)
      && (override === null || override.createdAt <= asOf) && a.evaluatedAt <= asOf && a.expiresAt > asOf
      && (a.ranking.earliestTriggerExpiresAt === null || a.ranking.earliestTriggerExpiresAt > asOf)
      && a.claims.every(claim => claim.certainty !== 'fact' || validateDiscoveryClaim({ snapshot: evidence, claim }));
  }

  private requireAssessment(request: BeginDiscoveryRequest, evidence: DiscoveryEvidenceSnapshot, asOf: string): DiscoveryAssessment {
    const assessment = this.input.services.discoveryRepository.getCurrent(evidence.prospectId);
    if (assessment === null || assessment.id !== request.assessmentId || assessment.fingerprint !== request.expectedFingerprint
      || request.personId !== evidence.personId || request.salesCycleId !== evidence.salesCycleId || !this.isCurrent(assessment, evidence, asOf)) {
      throw new Error('DISCOVERY_STALE_ASSESSMENT');
    }
    return assessment;
  }

  private requireEligible(assessment: DiscoveryAssessment, evidence: DiscoveryEvidenceSnapshot, asOf: string): void {
    const { services } = this.input;
    const person = services.identities.getPerson(evidence.personId);
    const provenance = z.object({ needsIdentity: z.boolean().optional() }).passthrough().nullable().safeParse(person?.provenance);
    const override = services.discoveryRepository.overrideForFingerprint(evidence.prospectId, evidence.inputFingerprint);
    if (assessment.disposition !== 'candidate' || !assessment.identitySupported || !evidence.identitySupported
      || evidence.unresolvedIdentity || evidence.conflicts.length > 0 || evidence.operationallyBlocked
      || evidence.stage !== 'unreviewed' || evidence.workflowStatus !== 'active' || evidence.qualificationState !== 'unreviewed'
      || evidence.resurfaceAt !== null && evidence.resurfaceAt > asOf || !provenance.success || provenance.data?.needsIdentity === true
      || /^unknown owner\b/i.test(evidence.personName.trim())
      || (override !== null && !override.evidenceChanged && override.decision !== 'reconsider')) {
      throw new Error('DISCOVERY_PREPARATION_NOT_ELIGIBLE');
    }
  }

  private receipt(personId: string, salesCycleId: string): MutationReceipt {
    const row = this.input.database.raw.prepare('SELECT total_changes() AS count').get() as { count: number };
    return mutationReceiptSchema.parse({ revision: row.count, affectedPersonIds: [personId], affectedSalesCycleIds: [salesCycleId] });
  }
}
