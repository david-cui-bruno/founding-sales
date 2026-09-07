import { z } from 'zod';
import { discoveryAssessmentSchema, discoveryClaimSchema, type DiscoveryClaim } from '../../shared/contracts/discoveryContract';
import type { AppDatabase } from '../db/database';
import type { DomainServices } from '../domain/createDomainServices';
import { collectDiscoveryEvidence, DiscoveryEvidenceDiagnosticError, validateDiscoveryClaim } from '../domain/discovery/discoveryEvidence';
import type { DiscoveryEvidenceSnapshot, DiscoveryScanPage } from '../domain/discovery/discoveryTypes';
import { buildRebuildCommand, deriveRefreshIdempotencyKey, scanPriorityProjections } from '../domain/startup/priorityProjectionRefresh';
import { PRIORITY_PROJECTION_REBUILD_JOB_TYPE } from '../domain/startup/domainStartupTypes';
import type { Clock } from '../domain/support/clock';
import type { IdGenerator } from '../domain/support/idGenerator';
import { resolveLocalDayInterval } from '../domain/today/todayOrdering';
import type { FoundationRuntime } from '../foundation/foundationRuntime';
import type { JobRecord, DiscoveryJobType } from '../jobs/jobRepository';
import { assessmentCommand, refreshCommand, hasRecovery } from '../jobs/discoveryRecovery';
import type { DiscoveryResearchPort } from './discoveryResearchPort';

const shape = discoveryAssessmentSchema.shape;
const priorityDiagnosticCommand = z.object({ formatVersion: z.literal(1), kind: z.literal('priority_diagnostic'),
  personId: shape.personId, prospectId: shape.prospectId, diagnostic: z.literal('invalid_evidence') }).strict();

export type DiscoveryResearchRequest = Readonly<{ epoch: symbol; jobId: string; personId: string;
  prospectId: string; salesCycleId: string; fingerprint: string; localDate: string; overrideId: string | null;
  claims: readonly DiscoveryClaim[]; questions: readonly string[] }>;

type Dependencies = { database: AppDatabase; services: DomainServices; clock: Clock; ids: IdGenerator };

/** Synchronous worker commands. The facade supplies its exact runtime service graph.
 * No source, qualification, assessment or scoring algorithm is reproduced here.
 */
export class DiscoveryWorkerCommands {
  private readonly epoch = Symbol('discovery-runtime');
  private readonly pages = new WeakMap<DiscoveryScanPage, { after: string | null; bytes: string }>();
  constructor(private readonly input: Dependencies) {}

  scanDiscoveryPage(input: { afterProspectId: string | null; limit: number }): DiscoveryScanPage {
    const page = this.input.services.discoveryRepository.listScanPage(input);
    this.pages.set(page, { after: input.afterProspectId, bytes: JSON.stringify(page) });
    return page;
  }

  enqueueDiscoveryPage(page: DiscoveryScanPage): void {
    const { services, clock } = this.input;
    services.unitOfWork.assertWriteScope();
    // A page cannot be forged, skipped, or replayed over an advanced cursor.
    const admitted = this.pages.get(page);
    if (!admitted || admitted.after !== services.discoveryRepository.readScanCursor() || admitted.bytes !== JSON.stringify(page)) {
      throw new Error('DISCOVERY_SCAN_PAGE_CHANGED');
    }
    this.pages.delete(page);
    const asOf = clock.now();
    for (const id of page.prospectIds) { this.enqueueAssessment(id, asOf); this.enqueueRefresh(id, asOf); }
    if (page.done) services.discoveryRepository.completeScan(asOf, this.day(asOf).localDate);
    else services.discoveryRepository.writeScanCursor(page.cursor);
  }

  scanAndEnqueueDiscoveryPage(): DiscoveryScanPage {
    const { services } = this.input;
    try {
      const page = services.unitOfWork.immediate(() => {
        const page = this.scanDiscoveryPage({ afterProspectId: services.discoveryRepository.readScanCursor(), limit: 50 });
        this.enqueueDiscoveryPage(page);
        return page;
      });
      services.discoveryRead.clearScanFailure(); // Clear only after this page really committed.
      return page;
    } catch (error) {
      services.discoveryRead.recordScanFailure(); // Outside rollback, still inside this synchronous runtime lease.
      throw error;
    }
  }

  discoveryWorkDelay(): { scan: number; job: number | null } {
    const { services, clock } = this.input; const at = clock.now();
    try {
      const state = services.discoveryRepository.readScanState();
      const scan = state.cursor !== null || state.lastCompleteScanAt === null || state.lastCompleteLocalDate !== this.day(at).localDate
        ? 0 : Math.max(0, Date.parse(state.lastCompleteScanAt) + 60_000 - Date.parse(at));
      return { scan, job: services.jobs.nextDiscoveryDelay(at) };
    } catch (error) {
      services.discoveryRead.recordScanFailure();
      throw error;
    }
  }

  processNextDiscoveryJob(): boolean {
    const { jobs } = this.input.services;
    const job = jobs.listDueDiscovery(this.input.clock.now(), 1)[0];
    if (!job) return false;
    if (job.state === 'running') {
      jobs.fail(job.id, { code: 'interrupted_by_restart', message: 'Local work interrupted.' }, this.input.clock.now());
    } else if (job.type === 'discovery_assessment') this.processDiscoveryJob(job.id);
    else this.processPriorityRefreshJob(job.id);
    return true;
  }

  processDiscoveryJob(id: string): void {
    this.execute(id, 'discovery_assessment', job => {
      if (priorityDiagnosticCommand.safeParse(job.payload).success) throw new DiscoveryEvidenceDiagnosticError('invalid_evidence');
      const command = assessmentCommand.parse(job.payload);
      const { services, clock } = this.input; const asOf = clock.now();
      const current = services.unitOfWork.immediate(() => {
        const snapshot = this.collect(command.prospectId, asOf);
        const assessment = services.discoveryRepository.getCurrent(command.prospectId);
        // Replay after committed assessment persistence does not create another assessment.
        if (assessment !== null && this.isCurrent(assessment, snapshot, asOf)) return 'complete';
        if (command.personId !== snapshot.personId || command.salesCycleId !== snapshot.salesCycleId
          || command.fingerprint !== snapshot.inputFingerprint || command.ruleVersionId !== snapshot.ruleVersionId
          || command.localDate !== this.day(asOf).localDate
          || command.overrideId !== (services.discoveryRepository.getLatestOverride(command.prospectId)?.id ?? null)) {
          this.requireReplacement(this.enqueueAssessment(command.prospectId, asOf), job.id); return 'superseded';
        }
        if (!hasRecovery(job) && job.idempotencyKey !== null) {
          const effective = this.enqueueAssessment(command.prospectId, asOf);
          if (effective?.id !== job.id) { this.requireReplacement(effective, job.id); return 'superseded'; }
        }
        return 'assess';
      });
      return current === 'assess' ? services.discovery.assess(command.prospectId) : { status: current };
    });
  }

  processPriorityRefreshJob(id: string): void {
    this.execute(id, PRIORITY_PROJECTION_REBUILD_JOB_TYPE, job => {
      const command = refreshCommand.parse(job.payload);
      if (command.jobId !== job.id) throw new Error('DISCOVERY_INVALID_COMMAND');
      const { services, clock } = this.input; const asOf = clock.now();
      return services.unitOfWork.immediate(() => {
        const candidate = this.refreshCandidate(command.prospectId, asOf);
        if (candidate === null) return { status: 'current_or_ineligible' };
        const timezone = services.workspaceSettings.read().timezone;
        const rule = services.prioritizationRepository.getActiveRuleVersion()!;
        if (command.ruleVersionId !== rule.id || command.founderTimezone !== timezone
          || command.founderLocalDate !== this.day(asOf).localDate
          || command.expectedProjectionVersion !== candidate.expectedProjectionVersion
          || command.qualifiedInputFingerprint !== candidate.qualifiedInputFingerprint
          || command.refreshFingerprint !== candidate.refreshFingerprint) {
          const replacement = this.enqueueRefresh(command.prospectId, asOf);
          if (replacement?.id !== job.id) {
            if (!replacement || !['queued', 'running'].includes(replacement.state)) throw new Error('DISCOVERY_REFRESH_NOT_RUNNABLE');
            return { status: 'superseded' };
          }
          // Timezone is deliberately absent from the established v1 key. An alias is
          // not a successor: execute this repair against the freshly validated inputs.
        }
        if (hasRecovery(job) && services.prioritizationRepository.getStoredEvaluationCommand(command.evaluationId)) {
          this.requireReplacement(this.enqueueRefresh(command.prospectId, asOf, job.id), job.id);
          return { status: 'superseded_recovery' };
        }
        if (!hasRecovery(job) && job.idempotencyKey !== null) {
          const effective = this.enqueueRefresh(command.prospectId, asOf);
          if (effective?.id !== job.id) { this.requireReplacement(effective, job.id); return { status: 'superseded' }; }
        }
        return services.prioritization.scopedWriter().recalculateProspect({ evaluationId: command.evaluationId,
          prospectId: command.prospectId, ruleVersionId: rule.id, evaluatedAt: asOf,
          expectedProjectionVersion: candidate.expectedProjectionVersion });
      });
    });
  }

  prepareDiscoveryResearch(): DiscoveryResearchRequest | null {
    const { services, clock } = this.input; const at = clock.now();
    const job = services.jobs.listDueDiscovery(at, 1)[0];
    if (!job || job.type !== 'discovery_assessment' || job.state === 'running') return null;
    try {
      return services.unitOfWork.immediate(() => {
        const command = assessmentCommand.parse(job.payload);
        services.jobs.validateDiscoveryRecovery(job);
        const snapshot = this.collect(command.prospectId, at);
        if (command.fingerprint !== snapshot.inputFingerprint || command.personId !== snapshot.personId
          || command.salesCycleId !== snapshot.salesCycleId || command.localDate !== this.day(at).localDate
          || command.overrideId !== (services.discoveryRepository.getLatestOverride(command.prospectId)?.id ?? null)) return null;
        // A canonical output-only alias must not spend an uncharged research attempt
        // before the synchronous dispatcher hands it to the bounded recovery tip.
        if (!hasRecovery(job) && job.idempotencyKey !== null
          && this.enqueueAssessment(command.prospectId, at)?.id !== job.id) return null;
        if (job.state === 'failed') services.jobs.retryFailed(job.id, at);
        services.jobs.start(job.id, at);
        return { epoch: this.epoch, jobId: job.id, personId: snapshot.personId, prospectId: snapshot.prospectId,
          salesCycleId: snapshot.salesCycleId, fingerprint: snapshot.inputFingerprint, localDate: command.localDate,
          overrideId: command.overrideId, claims: snapshot.claims,
          questions: services.discoveryRepository.getCurrent(command.prospectId)?.questions ?? [] };
      });
    } catch { return null; /* The synchronous dispatcher records the original diagnostic. */ }
  }

  completeDiscoveryResearch(request: DiscoveryResearchRequest, claims: readonly DiscoveryClaim[]): void {
    if (request.epoch !== this.epoch) return; // A replacement runtime can never apply the old runtime's response.
    const { services, clock } = this.input; const at = clock.now();
    if (services.jobs.get(request.jobId)?.state !== 'running') return;
    try {
      const current = services.unitOfWork.immediate(() => {
        const snapshot = this.collect(request.prospectId, at);
        if (request.personId !== snapshot.personId || request.salesCycleId !== snapshot.salesCycleId
          || request.fingerprint !== snapshot.inputFingerprint || request.localDate !== this.day(at).localDate
          || request.overrideId !== (services.discoveryRepository.getLatestOverride(request.prospectId)?.id ?? null)) {
          this.requireReplacement(this.enqueueAssessment(request.prospectId, at), request.jobId);
          services.jobs.succeed(request.jobId, { status: 'superseded_research' }, at); return false;
        }
        const validated = z.array(discoveryClaimSchema).max(100).parse(claims);
        if (!validated.every(claim => validateDiscoveryClaim({ snapshot, claim }))) throw new Error('DISCOVERY_INVALID_RESEARCH');
        return true;
      });
      // Local assessment only. Returned prose is never persisted as external knowledge.
      if (current) this.processDiscoveryJob(request.jobId);
    } catch (error) {
      const code = error instanceof DiscoveryEvidenceDiagnosticError ? error.code
        : error instanceof z.ZodError || error instanceof Error && error.message === 'DISCOVERY_INVALID_RESEARCH'
          ? 'invalid_research' : 'discovery_transient';
      this.failDiscoveryResearch(request, code);
    }
  }

  failDiscoveryResearch(request: DiscoveryResearchRequest,
    code: 'invalid_research' | 'research_timeout' | 'research_failed' | 'discovery_transient' | DiscoveryEvidenceDiagnosticError['code']): void {
    const { services, clock } = this.input;
    if (request.epoch !== this.epoch || services.jobs.get(request.jobId)?.state !== 'running') return;
    services.jobs.fail(request.jobId, { code, message: `Optional research refused: ${code}.` }, clock.now());
  }

  private execute(id: string, type: DiscoveryJobType, operation: (job: JobRecord) => unknown): void {
    const { jobs } = this.input.services; const at = this.input.clock.now();
    let job = jobs.get(id);
    if (!job || job.type !== type) throw new Error('DISCOVERY_JOB_NOT_OWNED');
    if (job.state === 'succeeded' || job.state === 'cancelled') return;
    if (job.state === 'failed') {
      if (!jobs.listDueDiscovery(at, 50).some(j => j.id === id)) return;
      job = jobs.retryFailed(id, at);
    }
    if (job.state === 'queued') jobs.start(id, at);
    try {
      jobs.validateDiscoveryRecovery(job);
      const result = operation(job);
      if (jobs.get(id)?.state === 'running') jobs.succeed(id, result, this.input.clock.now());
    }
    catch (error) {
      const code = error instanceof DiscoveryEvidenceDiagnosticError ? error.code
        : error instanceof z.ZodError || error instanceof Error && ['DISCOVERY_INVALID_COMMAND', 'DISCOVERY_INVALID_RECOVERY'].includes(error.message)
          ? 'invalid_command' : 'discovery_transient';
      jobs.fail(id, { code, message: `Local discovery work failed: ${code}.` }, this.input.clock.now());
    }
  }

  private collect(prospectId: string, asOf: string) {
    return collectDiscoveryEvidence({ database: this.input.database, services: this.input.services, prospectId, asOf });
  }
  private requireReplacement(job: JobRecord | undefined, previousId: string): void {
    if (!job || job.id === previousId || !['queued', 'running'].includes(job.state)) throw new Error('DISCOVERY_REFRESH_NOT_RUNNABLE');
  }
  private day(asOf: string) { return resolveLocalDayInterval({ generatedAt: asOf, timezone: this.input.services.workspaceSettings.read().timezone }); }
  private isCurrent(a: z.infer<typeof discoveryAssessmentSchema>, s: DiscoveryEvidenceSnapshot, at: string): boolean {
    const override = this.input.services.discoveryRepository.getLatestOverride(s.prospectId);
    return a.personId === s.personId && a.prospectId === s.prospectId && a.salesCycleId === s.salesCycleId && a.fingerprint === s.inputFingerprint
      && a.ruleVersionId === s.ruleVersionId && a.policyVersion === 'discovery-v1' && a.localDate === this.day(at).localDate
      && a.overrideId === (override?.id ?? null) && (override === null || override.createdAt <= at)
      && a.evaluatedAt <= at && a.expiresAt > at
      && (a.ranking.earliestTriggerExpiresAt === null || a.ranking.earliestTriggerExpiresAt > at)
      && a.claims.every(claim => claim.certainty !== 'fact' || validateDiscoveryClaim({ snapshot: s, claim }));
  }

  private enqueueAssessment(prospectId: string, asOf: string): JobRecord | undefined {
    const { services } = this.input;
    const identity = services.prioritizationRepository.loadQualificationInputs(prospectId);
    // Valid no-cycle Prospects still participate in priority refresh, never invented discovery context.
    if (services.discoveryRepository.getReadContext(identity.personId) === null) return;
    const previous = services.discoveryRepository.getCurrent(prospectId);
    let snapshot: DiscoveryEvidenceSnapshot | null = null;
    let diagnostic: 'evidence_too_large' | 'invalid_evidence' | null = null;
    try { snapshot = this.collect(prospectId, asOf); }
    catch (error) {
      if (!(error instanceof DiscoveryEvidenceDiagnosticError) || !['evidence_too_large', 'invalid_evidence'].includes(error.code)) throw error;
      diagnostic = error.code as typeof diagnostic;
    }
    const current = snapshot !== null && previous !== null && this.isCurrent(previous, snapshot, asOf);
    services.jobs.reconcileDiscoveryDiagnostics({ personId: identity.personId, prospectId,
      scope: 'assessment', proof: current ? 'current_result' : snapshot ? 'valid_evidence' : 'invalid' }, services.unitOfWork);
    if (current) return;
    const payload = assessmentCommand.parse({ formatVersion: 1, personId: identity.personId, prospectId,
      salesCycleId: snapshot?.salesCycleId ?? null, fingerprint: snapshot?.inputFingerprint ?? null,
      policyVersion: 'discovery-v1', ruleVersionId: services.prioritizationRepository.getActiveRuleVersion()!.id,
      localDate: this.day(asOf).localDate, overrideId: services.discoveryRepository.getLatestOverride(prospectId)?.id ?? null,
      generation: previous?.expiresAt ?? 'initial', diagnostic });
    // Diagnostic failures do not get a new command every poll/day. Repaired evidence gets a real fingerprint.
    const key = diagnostic ? ['discovery_assessment', identity.personId, prospectId, diagnostic]
      : ['discovery_assessment', payload.personId, prospectId, payload.salesCycleId, payload.fingerprint,
        payload.policyVersion, payload.ruleVersionId, payload.localDate, payload.overrideId, payload.generation];
    const input = { type: 'discovery_assessment', idempotencyKey: JSON.stringify(key), payload, at: asOf };
    return diagnostic ? services.jobs.enqueue(input) : services.jobs.enqueueDiscoveryRecovery(input, services.unitOfWork);
  }

  private refreshCandidate(prospectId: string, asOf: string) {
    const { services } = this.input;
    const identity = services.prioritizationRepository.loadQualificationInputs(prospectId);
    if (identity.qualificationState !== 'eligible' || identity.personDeletedAt !== null
      || services.outboundPermission.inspectPerson(identity.personId).kind === 'blocked') return null;
    const activeRule = services.prioritizationRepository.getActiveRuleVersion();
    if (!activeRule) throw new Error('DISCOVERY_ACTIVE_RULE_REQUIRED');
    const scan = scanPriorityProjections({ repository: services.prioritizationRepository, listEligibleProspectIds: () => [prospectId],
      activeRule, asOf, workspaceTimezone: services.workspaceSettings.read().timezone });
    services.jobs.reconcileDiscoveryDiagnostics({ personId: identity.personId, prospectId,
      scope: 'priority', proof: scan.corruptProspectIds.length ? 'invalid' : scan.candidates.length ? 'valid_evidence' : 'current_result' }, services.unitOfWork);
    if (scan.corruptProspectIds.length) throw new DiscoveryEvidenceDiagnosticError('invalid_evidence');
    return scan.candidates[0] ?? null;
  }
  private enqueueRefresh(prospectId: string, asOf: string, consumedJobId?: string): JobRecord | undefined {
    const { services, ids } = this.input;
    let candidate;
    try { candidate = this.refreshCandidate(prospectId, asOf); }
    catch (error) {
      if (!(error instanceof DiscoveryEvidenceDiagnosticError) || error.code !== 'invalid_evidence') throw error;
      const identity = services.prioritizationRepository.loadQualificationInputs(prospectId);
      const payload = priorityDiagnosticCommand.parse({ formatVersion: 1, kind: 'priority_diagnostic',
        personId: identity.personId, prospectId, diagnostic: 'invalid_evidence' });
      services.jobs.enqueue({ type: 'discovery_assessment', payload,
        idempotencyKey: JSON.stringify(['discovery_assessment', 'priority_diagnostic', identity.personId, prospectId]), at: asOf });
      return;
    }
    if (!candidate) return;
    const ruleVersionId = services.prioritizationRepository.getActiveRuleVersion()!.id;
    const founderTimezone = services.workspaceSettings.read().timezone;
    const founderLocalDate = this.day(asOf).localDate;
    const id = ids.next();
    return services.jobs.enqueueDiscoveryRecovery({ id, type: PRIORITY_PROJECTION_REBUILD_JOB_TYPE,
      idempotencyKey: deriveRefreshIdempotencyKey({ prospectId, ruleVersionId, founderLocalDate, refreshFingerprint: candidate.refreshFingerprint }),
      payload: buildRebuildCommand({ jobId: id, evaluationId: ids.next(), candidate, ruleVersionId, founderTimezone,
        founderLocalDate, evaluatedAt: asOf }), at: asOf }, services.unitOfWork, consumedJobId);
  }
}

export type DiscoveryWorker = { start(): void; wake(): void; stop(): void; idle(): Promise<void> };
export function createDiscoveryWorker(input: { domainGate: Pick<FoundationRuntime, 'withDomain'>;
  clock: Clock; research: DiscoveryResearchPort; schedule: (run: () => void, delayMs: number) => () => void }): DiscoveryWorker {
  let stopped = true; let epoch = 0; let ticket = 0; let cancelScheduled: (() => void) | undefined;
  let flight: Promise<void> | undefined; let wakeRequested = false;
  let researchAbort: AbortController | undefined;
  const arm = (delay: number): void => {
    cancelScheduled?.(); const generation = epoch; const scheduledTicket = ++ticket;
    cancelScheduled = input.schedule(() => {
      if (stopped || generation !== epoch || scheduledTicket !== ticket || flight) return;
      cancelScheduled = undefined;
      flight = pump(generation).catch((): undefined => undefined).finally(() => {
        flight = undefined;
        if (!stopped && generation !== epoch) { wakeRequested = false; arm(0); }
      }).catch((): undefined => undefined);
    }, delay);
  };
  const research = async (request: DiscoveryResearchRequest, active: () => boolean): Promise<void> => {
    const controller = new AbortController(); researchAbort = controller;
    let timedOut = false;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('DISCOVERY_RESEARCH_ABORTED'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const deadline = Date.parse(input.clock.now()) + 15_000;
    const cancelDeadline = input.schedule(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      const result = await Promise.race([aborted, Promise.resolve().then(() => input.research.research({
        personId: request.personId, claims: request.claims, questions: request.questions, signal: controller.signal,
      }))]);
      if (Date.parse(input.clock.now()) >= deadline) { timedOut = true; throw new Error('DISCOVERY_RESEARCH_DEADLINE'); }
      if (active()) await input.domainGate.withDomain(d => { if (active()) d.completeDiscoveryResearch(request, result); });
    } catch {
      if (active()) await input.domainGate.withDomain(d => { if (active()) d.failDiscoveryResearch(request, timedOut ? 'research_timeout' : 'research_failed'); });
    } finally {
      cancelDeadline(); controller.signal.removeEventListener('abort', onAbort);
      if (researchAbort === controller) researchAbort = undefined;
    }
  };
  const pump = async (generation: number): Promise<void> => {
    const active = () => !stopped && generation === epoch;
    let delay = 60_000;
    try {
      const work = await input.domainGate.withDomain(d => active() ? d.discoveryWorkDelay() : null);
      if (!active() || work === null) return;
      if (work.scan === 0) await input.domainGate.withDomain(d => { if (active()) d.scanAndEnqueueDiscoveryPage(); });
      for (let processed = 0; processed < 25 && active(); processed++) {
        if (input.research.capability() === 'available') {
          const request = await input.domainGate.withDomain(d => active() ? d.prepareDiscoveryResearch() : null);
          if (!active()) break;
          if (request) { await research(request, active); continue; }
        }
        const didWork = await input.domainGate.withDomain(d => active() && d.processNextDiscoveryJob());
        if (!didWork) break;
      }
      if (active()) {
        const next = await input.domainGate.withDomain(d => active() ? d.discoveryWorkDelay() : null);
        if (next) delay = Math.min(next.scan, next.job ?? 60_000);
      }
    } catch { delay = 60_000; /* Infrastructure/blocked runtime: bounded retry, no unhandled rejection. */ }
    finally { if (active()) { arm(wakeRequested ? 0 : delay); wakeRequested = false; } }
  };
  return {
    start() { if (!stopped) return; stopped = false; epoch++; if (flight) { wakeRequested = true; } else arm(0); },
    wake() { if (stopped) return; if (flight) wakeRequested = true; else arm(0); },
    stop() { stopped = true; epoch++; researchAbort?.abort(); wakeRequested = false; cancelScheduled?.(); cancelScheduled = undefined; },
    async idle() { await flight; },
  };
}
