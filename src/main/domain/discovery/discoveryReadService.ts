import { z } from 'zod';
import {
  discoveryBriefRequestSchema, discoveryBriefSchema, discoverySnapshotSchema,
  type DiscoveryAssessment, type DiscoveryBrief, type DiscoveryOverride, type DiscoverySnapshot,
} from '../../../shared/contracts/discoveryContract';
import type { AppDatabase } from '../../db/database';
import type { DomainServices } from '../createDomainServices';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../cadence/cadenceScheduler';
import type { Clock } from '../support/clock';
import type { DomainUnitOfWork } from '../support/domainUnitOfWork';
import { resolveLocalDayInterval } from '../today/todayOrdering';
import { buildDiscoveryPilotNextStep } from './discoveryBrief';
import { collectDiscoveryEvidence, DiscoveryEvidenceDiagnosticError, validateDiscoveryClaim } from './discoveryEvidence';
import { compareDiscoveryCandidates, selectDiscoveryCandidates } from './discoveryPolicy';
import type { DiscoveryReadBucket } from './discoveryRepository';
import type { DiscoveryEvidenceSnapshot } from './discoveryTypes';
import { DomainRepositoryDatabaseMismatchError } from '../support/domainErrors';

type Services = Pick<DomainServices, 'discoveryRepository' | 'today' | 'workspaceSettings' | 'jobs' |
  'identities' | 'sourceRepository' | 'events' | 'outboundPermission' | 'prioritizationRepository' | 'prioritization'>;
type ReadTime = { asOf: string; localDate: string; ruleVersionId: string | null };
type Checked = { brief: DiscoveryBrief; researchDiagnostic: boolean };
const MAX_CHECKS = 50;
const PAGE_SIZE = 10;
const jobTypes = ['discovery.scan', 'discovery.assess', 'discovery.research'] as const;

/** SELECT-only composition. No preparation, refresh, worker reference, or cached evidence. */
export class DiscoveryReadService {
  constructor(private readonly input: { database: AppDatabase; unitOfWork: DomainUnitOfWork; services: Services; clock: Clock }) {
    const { database, unitOfWork, services } = input;
    services.discoveryRepository.assertBoundTo(database, unitOfWork);
    services.today.assertBoundTo(database, unitOfWork);
    services.identities.assertBoundTo(database, unitOfWork);
    services.sourceRepository.assertBoundTo(database, unitOfWork);
    services.events.assertBoundTo(database, unitOfWork);
    services.outboundPermission.assertBoundTo(database, unitOfWork);
    services.prioritizationRepository.assertBoundTo(database, unitOfWork);
    services.workspaceSettings.assertBoundTo(database, unitOfWork);
    this.input = { ...input, services: { ...services } };
  }

  assertBoundTo(database: AppDatabase, unitOfWork: DomainUnitOfWork,
    services: Pick<Services, 'identities' | 'sourceRepository' | 'events' | 'outboundPermission' |
      'prioritizationRepository' | 'prioritization' | 'workspaceSettings' | 'discoveryRepository'>): void {
    const keys = ['identities', 'sourceRepository', 'events', 'outboundPermission',
      'prioritizationRepository', 'prioritization', 'workspaceSettings', 'discoveryRepository'] as const;
    if (this.input.database !== database || this.input.unitOfWork !== unitOfWork
      || keys.some(key => this.input.services[key] !== services[key])) {
      throw new DomainRepositoryDatabaseMismatchError();
    }
  }

  get(): DiscoverySnapshot {
    return this.inReadScope(asOf => discoverySnapshotSchema.parse(this.readSnapshotInScope(asOf)));
  }

  getBrief(personId: string): DiscoveryBrief {
    return this.inReadScope(asOf => {
      const request = discoveryBriefRequestSchema.parse({ personId });
      const context = this.input.services.discoveryRepository.getReadContext(request.personId);
      if (context === null) throw new Error('DISCOVERY_PERSON_NOT_FOUND');
      const assessment = this.input.services.discoveryRepository.getCurrent(context.prospectId);
      return discoveryBriefSchema.parse(this.check(context, assessment, this.readTime(asOf)).brief);
    });
  }

  /** Preparation uses this same helper inside its own UOW. It already subtracts queued/completed work. */
  remainingCapacityInScope(asOf: string): number {
    const { database, services } = this.input;
    if (!database.raw.inTransaction) throw new Error('DISCOVERY_READ_SCOPE_REQUIRED');
    const settings = services.workspaceSettings.read();
    return services.today.buildInCurrentSnapshot({ generatedAt: asOf, timezone: settings.timezone,
      capacity: { dialBudget: settings.dailyDialCapacity, conversationTarget: settings.dailyConversationTarget,
        explorationSlots: settings.explorationSlots, resurfacingWindowSeconds: settings.resurfaceSuppressionDays * 86_400 },
      channelPolicies: FOUNDER_CHANNEL_POLICIES_V1 }).remainingDiscretionaryDialCount;
  }

  private inReadScope<T>(read: (asOf: string) => T): T {
    const { database, clock } = this.input;
    if (database.raw.inTransaction) throw new Error('DISCOVERY_READ_SCOPE_REQUIRED');
    database.raw.exec('BEGIN');
    try { return read(clock.now()); } finally { database.raw.exec('ROLLBACK'); }
  }

  private readTime(asOf: string): ReadTime {
    const { services } = this.input;
    const settings = services.workspaceSettings.read();
    const { localDate } = resolveLocalDayInterval({ generatedAt: asOf, timezone: settings.timezone });
    return { asOf, localDate, ruleVersionId: services.prioritizationRepository.getActiveRuleVersion()?.id ?? null };
  }

  private readSnapshotInScope(asOf: string): DiscoverySnapshot {
    const { database, services } = this.input;
    const time = this.readTime(asOf);
    const limit = Math.min(10, this.remainingCapacityInScope(asOf));
    const counts = { unassessed: services.discoveryRepository.countReadOwners(), research: 0, watch: 0, excluded: 0 };
    const candidates: DiscoveryBrief[] = []; const judgment: DiscoveryBrief[] = [];
    // Round-robin ranked pages reserve evidence work for exploration AND judgment.
    // The limit bounds rows visited as well as full collections, including failed collections.
    const buckets: Array<{ bucket: DiscoveryReadBucket; offset: number; done: boolean }> =
      ['primary', 'exploration', 'judgment', 'other'].map(bucket => ({ bucket: bucket as DiscoveryReadBucket, offset: 0, done: false }));
    let visited = 0;
    while (visited < MAX_CHECKS && buckets.some(b => !b.done)) {
      for (const page of buckets) {
        if (page.done || visited === MAX_CHECKS) continue;
        const pageSize = Math.min(PAGE_SIZE, MAX_CHECKS - visited);
        const rows = services.discoveryRepository.listRankedCurrentPage({ bucket: page.bucket, offset: page.offset, limit: pageSize });
        page.offset += rows.length; page.done = rows.length < pageSize;
        for (const assessment of rows) {
          visited += 1;
          const context = services.discoveryRepository.getReadContext(assessment.personId);
          if (context === null) throw new Error('Discovery storage is corrupt.');
          const { brief, researchDiagnostic } = this.check(context, assessment, time);
          if (researchDiagnostic) counts.research += 1; // Research diagnostics overlap pending until assessed successfully.
          if (brief.stale || brief.assessment === null) continue;
          counts.unassessed -= 1;
          const disposition = effectiveDisposition(assessment, brief.latestOverride);
          if (disposition === 'candidate') candidates.push(brief);
          else if (disposition === 'judgment') judgment.push(brief);
          else counts[disposition] += 1;
        }
      }
    }
    const selected = selectDiscoveryCandidates({ assessments: candidates.map(b => b.assessment!), limit });
    const byId = new Map(candidates.map(b => [b.assessment!.id, b]));
    judgment.sort((a, b) => compareDiscoveryCandidates(a.assessment!, b.assessment!));
    return { prepared: selected.map(a => byId.get(a.id)!), judgment: judgment.slice(0, 20), counts,
      processing: this.processing(), researchCapability: 'not_configured', generatedAt: asOf,
      revision: z.object({ count: discoverySnapshotSchema.shape.revision }).parse(database.raw.prepare('SELECT total_changes() AS count').get()).count };
  }

  private check(context: { personId: string; prospectId: string; salesCycleId: string; personName: string },
    assessment: DiscoveryAssessment | null, time: ReadTime): Checked {
    const { database, services } = this.input;
    let snapshot: DiscoveryEvidenceSnapshot;
    try {
      // Always collect with THIS query's clock, never WeakMap admission's captured asOf.
      snapshot = collectDiscoveryEvidence({ database, services, prospectId: context.prospectId, asOf: time.asOf });
    } catch (error) {
      // Size is a known retryable research limitation. Invalid storage and unrelated errors remain fatal.
      if (!(error instanceof DiscoveryEvidenceDiagnosticError) || error.code !== 'evidence_too_large') throw error;
      return { researchDiagnostic: true, brief: { personId: context.personId, salesCycleId: context.salesCycleId,
        personName: context.personName, stale: true, pilotNextStep: null,
        latestOverride: services.discoveryRepository.getLatestOverride(context.prospectId),
        assessment: assessment?.salesCycleId === context.salesCycleId ? { ...assessment, claims: [], questions: [],
          unknowns: ['Evidence too large to verify; additional research is pending', ...assessment.unknowns].slice(0, 50) } : null } };
    }
    const latestOverride = services.discoveryRepository.overrideForFingerprint(context.prospectId, snapshot.inputFingerprint);
    if (latestOverride !== null && latestOverride.createdAt > time.asOf) throw new Error('Discovery override cannot be in the future.');
    const sameCycle = assessment?.salesCycleId === snapshot.salesCycleId;
    const current = assessment !== null && sameCycle && assessment.personId === snapshot.personId
      && assessment.prospectId === snapshot.prospectId && assessment.fingerprint === snapshot.inputFingerprint
      && assessment.policyVersion === 'discovery-v1' && assessment.ruleVersionId === time.ruleVersionId
      && assessment.ruleVersionId === snapshot.ruleVersionId && assessment.localDate === time.localDate
      && assessment.overrideId === (latestOverride?.id ?? null) && assessment.evaluatedAt <= time.asOf
      && assessment.expiresAt > time.asOf
      && (assessment.ranking.earliestTriggerExpiresAt === null || assessment.ranking.earliestTriggerExpiresAt > time.asOf)
      && assessment.claims.every(claim => claim.certainty !== 'fact' || validateDiscoveryClaim({ snapshot, claim }));
    // Historical scores are explicitly stale. Invalidated quotes/facts must not be re-presented even there.
    const visible = sameCycle && assessment !== null ? (current ? assessment : { ...assessment,
      claims: assessment.claims.filter(claim => validateDiscoveryClaim({ snapshot, claim })), questions: [] }) : null;
    return { researchDiagnostic: false, brief: { personId: snapshot.personId, salesCycleId: snapshot.salesCycleId,
      personName: snapshot.personName, assessment: visible, stale: assessment !== null && !current, latestOverride,
      pilotNextStep: current && effectiveDisposition(assessment, latestOverride) === 'candidate' ? this.pilot(snapshot) : null } };
  }

  private pilot(snapshot: DiscoveryEvidenceSnapshot): DiscoveryBrief['pilotNextStep'] {
    const { database, services } = this.input;
    const activities = snapshot.conversationActivityIds.map(id => services.events.getActivity(id))
      .filter(a => a !== null && a.salesCycleId === snapshot.salesCycleId && a.personId === snapshot.personId);
    const row = database.raw.prepare(`SELECT a.id, a.action_type AS actionType, a.created_at AS createdAt
      FROM sales_cycles c JOIN next_actions a ON a.id = c.current_next_action_id AND a.sales_cycle_id = c.id
      WHERE c.id = ? AND a.status = 'pending'`).get(snapshot.salesCycleId);
    const followUp = row === undefined ? null : z.object({ id: z.string().min(1), actionType: z.string().min(1),
      createdAt: discoverySnapshotSchema.shape.generatedAt }).strict().parse(row);
    return buildDiscoveryPilotNextStep({ snapshot, activities, followUp });
  }

  private processing(): DiscoverySnapshot['processing'] {
    const { database, services } = this.input;
    services.discoveryRepository.readScanCursor(); // Validate durable scan state, never start/resume it.
    const latest = jobTypes.flatMap(type => {
      const row = database.raw.prepare(`SELECT id FROM jobs WHERE type = ?
        ORDER BY created_at DESC, id COLLATE BINARY DESC LIMIT 1`).get(type) as { id: string } | undefined;
      return row === undefined ? [] : [services.jobs.get(row.id)!];
    });
    // Active state is indexed and authoritative even if a newer queued job exists.
    for (const type of jobTypes) {
      const row = database.raw.prepare("SELECT id FROM jobs WHERE type = ? AND state = 'running' LIMIT 1").get(type) as { id: string } | undefined;
      if (row !== undefined && services.jobs.get(row.id)?.state === 'running') return 'running';
    }
    if (latest.some(job => job.state === 'failed')) return 'error';
    if (latest.some(job => job.state === 'cancelled')) return 'paused';
    return 'idle';
  }
}

function effectiveDisposition(assessment: DiscoveryAssessment, override: DiscoveryOverride | null): DiscoveryAssessment['disposition'] {
  // An override only affects discovery visibility. New evidence retains provenance, not the old suppression.
  if (assessment.disposition === 'excluded') return 'excluded';
  if (override !== null && !override.evidenceChanged) {
    if (override.decision === 'watch') return 'watch';
    if (override.decision === 'exclude') return 'excluded';
  }
  return assessment.disposition;
}
