import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import type { PriorityProjectionRebuildCommandV1 } from '../../src/main/domain/startup/domainStartupTypes';
import {
  PRIORITY_PROJECTION_REBUILD_JOB_TYPE,
} from '../../src/main/domain/startup/domainStartupTypes';
import {
  deriveRefreshIdempotencyKey,
  fingerprintCanonical,
} from '../../src/main/domain/startup/priorityProjectionRefresh';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  PrioritizationRepository,
} from '../../src/main/domain/prioritization/prioritizationRepository';
import {
  PrioritizationService,
} from '../../src/main/domain/prioritization/prioritizationService';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import {
  OutboundPermissionService,
} from '../../src/main/domain/optOut/outboundPermissionService';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect, type SeededProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const BOOT_AT = '2026-08-30T12:00:00.000Z';

describe('priority projection refresh at startup', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let phoneCounter = 5000;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  let runtimeCounter = 0;

  function buildRuntime(clock = { now: () => BOOT_AT }) {
    runtimeCounter += 1;
    const prefix = `refresh-id-${runtimeCounter}`;
    let idCounter = 0;
    const ids = { next: () => `${prefix}-${++idCounter}` };
    return new DomainRuntime({ database, clock, ids });
  }

  function buildPrioritizationStack() {
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => BOOT_AT };
    const ids = {
      next: (): string => {
        throw new Error('unused');
      },
    };
    const repository = new PrioritizationRepository({ database, unitOfWork, clock });
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const optOuts = new OptOutRepository({ database, unitOfWork });
    const outboundPermission = new OutboundPermissionService({
      database, unitOfWork, identities, optOuts,
    });
    const priorities = new PrioritizationService({
      database, unitOfWork, clock, repository, outboundPermission,
    });
    return { unitOfWork, repository, priorities };
  }

  function addDirectPhone(prospect: SeededProspect, id: string): void {
    phoneCounter += 1;
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES (?, ?, 'phone', ?, 'valid', 'direct', 1, ?, ?)
    `).run(id, prospect.personId, `+1401555${phoneCounter}`,
      DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  function failedRecoveryFixture(existingProjection = false) {
    const owner = seedProspect(database.raw, 'recovery');
    let at = BOOT_AT;
    const clock = { now: () => at };
    const runtime = buildRuntime(clock); runtime.initialize();
    const services = runtime.getServices();
    const domain = createFounderSalesDomain({ database, services, clock, ids: { next: () => `recovery-${++runtimeCounter}` } });
    if (existingProjection) {
      domain.processPriorityRefreshJob(services.jobs.listActive()[0]!.id);
      at = '2026-08-31T12:00:00.000Z'; domain.scanAndEnqueueDiscoveryPage();
    }
    const root = services.jobs.listActive()[0]!;
    const original = database.raw.prepare('SELECT observed_at AS bytes FROM source_events WHERE id = ?')
      .get(owner.sourceEventId) as { bytes: string };
    const trigger = database.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'immutable_source_events'").get() as { sql: string };
    database.raw.exec('DROP TRIGGER immutable_source_events');
    const source = (bytes: string) => database.raw.prepare('UPDATE source_events SET observed_at = ? WHERE id = ?').run(bytes, owner.sourceEventId);
    const corrupt = () => source('not-a-timestamp');
    const restore = () => source(original.bytes);
    const advance = () => { at = new Date(Date.parse(at) + 60_000).toISOString(); };
    corrupt(); domain.processPriorityRefreshJob(root.id);
    const failed = services.jobs.get(root.id)!;
    expect(failed.error?.code).toBe('invalid_evidence');
    restore(); advance();
    return { owner, services, domain, failed, corrupt, restore, advance, clock,
      restoreSchema: () => database.raw.exec(trigger.sql), setAt: (value: string) => { at = value; } };
  }

  // Seed a persisted recovery checkpoint using real dispatch/output, not a fabricated
  // projection or failure. Only the new ledger metadata/count is fixture-injected.
  function recoveryCheckpoint(f: ReturnType<typeof failedRecoveryFixture>, state: 'succeeded' | 'failed') {
    const original = f.failed.payload as PriorityProjectionRebuildCommandV1;
    const id = `checkpoint-${++runtimeCounter}`;
    const payload = { ...original, jobId: id, evaluationId: `${id}-evaluation`, evaluatedAt: f.clock.now() };
    f.services.jobs.enqueue({ id, type: PRIORITY_PROJECTION_REBUILD_JOB_TYPE, payload, at: f.clock.now() });
    if (state === 'failed') f.corrupt();
    f.domain.processPriorityRefreshJob(id);
    expect(f.services.jobs.get(id)?.state).toBe(state);
    if (state === 'failed') expect(f.services.jobs.get(id)?.error?.code).toBe('invalid_evidence');
    f.restore();
    const key = JSON.stringify(['discovery_recovery_v1', PRIORITY_PROJECTION_REBUILD_JOB_TYPE,
      payload.prospectId, payload.ruleVersionId, payload.founderLocalDate, payload.qualifiedInputFingerprint, 1]);
    database.raw.prepare('UPDATE jobs SET idempotency_key = ?, payload_json = ?, retry_count = 1 WHERE id = ?')
      .run(key, JSON.stringify({ ...payload, recovery: { kind: 'discovery_recovery_v1', rootJobId: f.failed.id } }), id);
    f.advance();
    return f.services.jobs.get(id)!;
  }

  it('recovers actual v1 invalid evidence with a fresh evaluation and unchanged original command', () => {
    const f = failedRecoveryFixture();
    f.domain.scanAndEnqueueDiscoveryPage();
    expect(f.services.prioritizationRepository.getProjection(f.owner.prospectId)).toBeNull();
    expect(f.domain.processNextDiscoveryJob()).toBe(true);
    const projection = f.services.prioritizationRepository.getProjection(f.owner.prospectId)!;
    expect(projection).not.toBeNull();
    expect(projection.evaluationId).not.toBe((f.failed.payload as PriorityProjectionRebuildCommandV1).evaluationId);
    f.domain.scanAndEnqueueDiscoveryPage();
    expect(f.domain.getDiscovery().processing).toBe('idle');
    expect(f.services.jobs.get(f.failed.id)).toEqual({ ...f.failed, result: { kind: 'discovery_diagnostic_status_v1', status: 'resolved' } });
  });

  it('reconstructs missing output after prior real recovery success instead of replaying its old evaluation', () => {
    const f = failedRecoveryFixture(); const first = recoveryCheckpoint(f, 'succeeded');
    f.domain.scanAndEnqueueDiscoveryPage();
    const prior = f.services.prioritizationRepository.getProjection(f.owner.prospectId)!;
    database.raw.prepare('DELETE FROM prospect_priority_projection WHERE prospect_id = ?').run(f.owner.prospectId);
    f.domain.scanAndEnqueueDiscoveryPage();
    expect(f.services.jobs.get(f.failed.id)?.result).toEqual({ kind: 'discovery_diagnostic_status_v1', status: 'unresolved' });
    expect(f.domain.processNextDiscoveryJob()).toBe(true);
    const current = f.services.prioritizationRepository.getProjection(f.owner.prospectId)!;
    expect(current).not.toBeNull(); expect(current.evaluationId).not.toBe(prior.evaluationId);
    expect(f.services.prioritizationRepository.getEvaluationById(prior.evaluationId)).not.toBeNull();
    expect(f.services.jobs.get(first.id)).toEqual(first);
  });

  it('recovers an evidence-failed recovery itself without resetting the original retry allowance', () => {
    const f = failedRecoveryFixture(); const first = recoveryCheckpoint(f, 'failed');
    f.domain.scanAndEnqueueDiscoveryPage();
    expect(f.domain.processNextDiscoveryJob()).toBe(true);
    expect(f.services.prioritizationRepository.getProjection(f.owner.prospectId)).not.toBeNull();
    const succeeded = f.services.jobs.listByTypeState(PRIORITY_PROJECTION_REBUILD_JOB_TYPE, 'succeeded', 50);
    expect(succeeded).toHaveLength(1); expect(succeeded[0]?.retryCount).toBe(2);
    expect(f.services.jobs.get(first.id)).toEqual(first);
    expect(f.services.jobs.get(f.failed.id)).toEqual(f.failed);
  });

  it('retains the recovery locator when projection identity disappears and startup queues an output-only canonical alias', () => {
    const f = failedRecoveryFixture(true);
    expect(f.failed.payload).toMatchObject({ expectedProjectionVersion: 1 });
    f.domain.scanAndEnqueueDiscoveryPage(); f.domain.processNextDiscoveryJob(); f.domain.scanAndEnqueueDiscoveryPage();
    const first = f.services.jobs.listByTypeState(PRIORITY_PROJECTION_REBUILD_JOB_TYPE, 'succeeded', 50)
      .find(job => (job.payload as { recovery?: unknown }).recovery)!;
    expect(first.retryCount).toBe(1);
    database.raw.prepare('DELETE FROM prospect_priority_projection WHERE prospect_id = ?').run(f.owner.prospectId);
    f.restoreSchema(); f.advance();
    const startup = buildRuntime(f.clock); startup.initialize();
    const alias = f.services.jobs.listByTypeState(PRIORITY_PROJECTION_REBUILD_JOB_TYPE, 'queued', 50)[0]!;
    expect(alias.retryCount).toBe(0);
    f.domain.processPriorityRefreshJob(alias.id);
    expect(f.services.jobs.get(alias.id)?.result).toEqual({ status: 'superseded' });
    const next = f.services.jobs.listByTypeState(PRIORITY_PROJECTION_REBUILD_JOB_TYPE, 'queued', 50)[0]!;
    expect(next).toMatchObject({ retryCount: 2, payload: { expectedProjectionVersion: null,
      reasons: ['missing_projection'], recovery: { rootJobId: f.failed.id } } });
    expect((next.payload as PriorityProjectionRebuildCommandV1).refreshFingerprint)
      .not.toBe((f.failed.payload as PriorityProjectionRebuildCommandV1).refreshFingerprint);
    f.domain.processNextDiscoveryJob();
    expect(f.services.prioritizationRepository.getProjection(f.owner.prospectId)).not.toBeNull();
    expect(f.services.jobs.get(first.id)).toEqual(first);
  });

  it.each(['timezone', 'source', 'rule', 'day', 'projection'] as const)('revalidates %s during actual recovery without stale writes or false supersession', change => {
    const f = failedRecoveryFixture(); f.domain.scanAndEnqueueDiscoveryPage();
    const child = f.services.jobs.listByTypeState(PRIORITY_PROJECTION_REBUILD_JOB_TYPE, 'queued', 50)[0]!;
    if (change === 'timezone') database.raw.prepare("UPDATE workspace_settings SET timezone = 'America/Chicago' WHERE singleton = 1").run();
    if (change === 'source') addDirectPhone(f.owner, 'recovery-new-phone');
    if (change === 'rule') f.services.unitOfWork.immediate(() => {
      f.services.prioritizationRepository.installRuleVersion({ ...f.services.prioritizationRepository.getActiveRuleVersion()!.document, id: 'recovery-rule', version: 2 });
      f.services.prioritizationRepository.activateRuleVersion({ ruleVersionId: 'recovery-rule', expectedActiveRuleVersionId: 'founder-priority-v1' });
    });
    if (change === 'day') f.setAt('2026-08-31T12:00:00.000Z');
    if (change === 'projection') f.services.prioritization.recalculateProspect({ evaluationId: 'newer-than-recovery', prospectId: f.owner.prospectId,
      ruleVersionId: 'founder-priority-v1', evaluatedAt: f.clock.now(), expectedProjectionVersion: null });
    f.domain.processPriorityRefreshJob(child.id);
    expect(f.services.jobs.get(child.id)).toMatchObject({ state: 'succeeded', payload: child.payload, retryCount: 1 });
    if (change === 'source' || change === 'rule' || change === 'day') expect(f.domain.processNextDiscoveryJob()).toBe(true);
    const projection = f.services.prioritizationRepository.getProjection(f.owner.prospectId)!;
    expect(projection).not.toBeNull();
    if (change === 'timezone') expect(f.services.jobs.get(child.id)?.result).not.toEqual({ status: 'superseded' });
    if (change === 'source') expect(projection.reachability).toBe('direct');
    if (change === 'rule') expect(projection.ruleVersionId).toBe('recovery-rule');
    if (change === 'projection') expect(projection.evaluationId).toBe('newer-than-recovery');
  });

  it.each([false, true])('keeps consumed-evaluation handoff atomic and never reports missing output repaired, exhausted=%s', exhausted => {
    const f = failedRecoveryFixture();
    if (exhausted) database.raw.prepare('UPDATE jobs SET retry_count = 2 WHERE id = ?').run(f.failed.id);
    f.domain.scanAndEnqueueDiscoveryPage();
    const child = f.services.jobs.listByTypeState(PRIORITY_PROJECTION_REBUILD_JOB_TYPE, 'queued', 50)[0]!;
    const command = child.payload as PriorityProjectionRebuildCommandV1;
    f.services.jobs.start(child.id, f.clock.now());
    f.services.prioritization.recalculateProspect({ evaluationId: command.evaluationId, prospectId: command.prospectId,
      ruleVersionId: command.ruleVersionId, evaluatedAt: command.evaluatedAt, expectedProjectionVersion: command.expectedProjectionVersion });
    database.raw.prepare('DELETE FROM prospect_priority_projection WHERE prospect_id = ?').run(f.owner.prospectId);
    const succeed = vi.spyOn(f.services.jobs, 'succeed');
    if (!exhausted) succeed.mockImplementationOnce(() => { throw new Error('Synthetic handoff completion rollback'); });
    f.domain.processPriorityRefreshJob(child.id);
    succeed.mockRestore();
    expect(f.services.prioritizationRepository.getProjection(f.owner.prospectId)).toBeNull();
    expect(f.services.jobs.get(child.id)).toMatchObject({ state: 'failed', retryCount: exhausted ? 3 : 1 });
    expect(database.raw.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 2 });
    f.advance();
    if (exhausted) {
      f.domain.scanAndEnqueueDiscoveryPage();
      expect(f.domain.processNextDiscoveryJob()).toBe(false); expect(f.domain.getDiscovery().processing).toBe('error');
    } else {
      f.domain.processPriorityRefreshJob(child.id);
      const replacement = f.services.jobs.listByTypeState(PRIORITY_PROJECTION_REBUILD_JOB_TYPE, 'queued', 50)[0]!;
      expect(replacement.retryCount).toBe(3);
      expect(f.services.jobs.get(child.id)?.result).toEqual({ status: 'superseded_recovery', successorJobId: replacement.id });
      f.domain.processPriorityRefreshJob(replacement.id);
      expect(f.services.prioritizationRepository.getProjection(f.owner.prospectId)?.evaluationId).not.toBe(command.evaluationId);
    }
    expect(f.services.prioritizationRepository.getEvaluationById(command.evaluationId)).not.toBeNull();
  });

  it.each(['source', 'day'])('supersedes a consumed recovery evaluation after genuinely changed %s instead of forcing the old lineage', change => {
    const f = failedRecoveryFixture(); f.domain.scanAndEnqueueDiscoveryPage();
    const child = f.services.jobs.listByTypeState(PRIORITY_PROJECTION_REBUILD_JOB_TYPE, 'queued', 50)[0]!;
    const command = child.payload as PriorityProjectionRebuildCommandV1;
    f.services.jobs.start(child.id, f.clock.now());
    f.services.prioritization.recalculateProspect({ evaluationId: command.evaluationId, prospectId: command.prospectId,
      ruleVersionId: command.ruleVersionId, evaluatedAt: command.evaluatedAt, expectedProjectionVersion: command.expectedProjectionVersion });
    database.raw.prepare('DELETE FROM prospect_priority_projection WHERE prospect_id = ?').run(f.owner.prospectId);
    if (change === 'source') addDirectPhone(f.owner, 'changed-after-consumed-evaluation');
    else f.setAt('2026-08-31T12:00:00.000Z');
    f.domain.processPriorityRefreshJob(child.id);
    expect(f.services.jobs.get(child.id)).toMatchObject({ state: 'succeeded', result: { status: 'superseded' }, payload: child.payload });
    expect(f.domain.processNextDiscoveryJob()).toBe(true);
    const projection = f.services.prioritizationRepository.getProjection(f.owner.prospectId)!;
    expect(projection).not.toBeNull(); expect(projection.evaluationId).not.toBe(command.evaluationId);
    expect(f.services.prioritizationRepository.getEvaluationById(command.evaluationId)).not.toBeNull();
  });

  it('queues a missing-projection rebuild job for an eligible prospect', () => {
    seedProspect(database.raw, 'refresh-missing');
    const report = buildRuntime().initialize();
    expect(report.projectionRefreshCandidateCount).toBe(1);
    expect(report.projectionRebuildsQueued).toBe(1);
    expect(report.pendingProjectionRebuilds).toBe(1);
    const job = database.raw.prepare(`
      SELECT type, state, idempotency_key, payload_json FROM jobs
      WHERE type = ?
    `).get(PRIORITY_PROJECTION_REBUILD_JOB_TYPE) as {
      type: string; state: string; idempotency_key: string; payload_json: string;
    };
    expect(job.state).toBe('queued');
    expect(job.type).toBe('priority_projection_rebuild_v1');
    const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({
      formatVersion: 1,
      prospectId: 'refresh-missing-prospect',
      ruleVersionId: 'founder-priority-v1',
      founderTimezone: 'America/New_York',
      evaluatedAt: BOOT_AT,
      expectedProjectionVersion: null,
      reasons: ['missing_projection'],
    });
    expect(job.idempotency_key).toBe(deriveRefreshIdempotencyKey({
      prospectId: 'refresh-missing-prospect',
      ruleVersionId: 'founder-priority-v1',
      founderLocalDate: '2026-08-30',
      refreshFingerprint: payload.refreshFingerprint as string,
    }));
  });

  it('executes the actual startup-enqueued durable v1 command through prioritization', () => {
    const p = seedProspect(database.raw, 'execute-refresh');
    const runtime = buildRuntime(); runtime.initialize();
    const services = runtime.getServices();
    const queued = services.jobs.listActive().find(j => j.type === PRIORITY_PROJECTION_REBUILD_JOB_TYPE)!;
    const domain = createFounderSalesDomain({ database, services, clock: { now: () => BOOT_AT }, ids: { next: () => 'unused-id' } });
    domain.processPriorityRefreshJob(queued.id);
    expect(services.jobs.get(queued.id)?.state).toBe('succeeded');
    expect(services.prioritizationRepository.getProjection(p.prospectId)).toMatchObject({ ruleVersionId: 'founder-priority-v1', version: 1 });
    const before = services.prioritizationRepository.getProjection(p.prospectId);
    domain.processPriorityRefreshJob(queued.id);
    expect(services.prioritizationRepository.getProjection(p.prospectId)).toEqual(before);
  });

  it('repairs a same-date timezone change without losing the canonical startup job', () => {
    const at = '2026-09-06T12:00:00.000Z';
    const p = seedProspect(database.raw, 'timezone-alias');
    let id = 0;
    const clock = { now: () => at }; const ids = { next: () => `timezone-${++id}` };
    const runtime = new DomainRuntime({ database, clock, ids }); runtime.initialize();
    const services = runtime.getServices();
    const old = services.jobs.listActive().find(job => job.type === PRIORITY_PROJECTION_REBUILD_JOB_TYPE)!;
    expect(old.payload).toMatchObject({ founderTimezone: 'America/New_York', founderLocalDate: '2026-09-06' });
    database.raw.prepare("UPDATE workspace_settings SET timezone = 'America/Chicago' WHERE singleton = 1").run();
    const domain = createFounderSalesDomain({ database, services, clock, ids });
    domain.processPriorityRefreshJob(old.id);
    expect(services.prioritizationRepository.getProjection(p.prospectId)).toMatchObject({ version: 1, evaluatedAt: at });
    expect(services.jobs.get(old.id)).toMatchObject({ state: 'succeeded', payload: old.payload, idempotencyKey: old.idempotencyKey });
    expect(services.jobs.get(old.id)?.result).not.toEqual({ status: 'superseded' });
    domain.scanAndEnqueueDiscoveryPage();
    expect(domain.processNextDiscoveryJob()).toBe(false);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 });
    expect(domain.getDiscovery().processing).toBe('idle');
  });

  it('keeps a failed normal v1 repair unresolved until a real current projection exists', () => {
    const p = seedProspect(database.raw, 'failed-v1-proof'); const runtime = buildRuntime(); runtime.initialize();
    const services = runtime.getServices(); const old = services.jobs.listActive()[0]!;
    services.jobs.start(old.id, BOOT_AT); services.jobs.fail(old.id, { code: 'invalid_evidence', message: 'Original failure.' }, BOOT_AT);
    const failed = services.jobs.get(old.id)!;
    const domain = createFounderSalesDomain({ database, services, clock: { now: () => BOOT_AT }, ids: { next: () => `proof-${++runtimeCounter}` } });
    domain.scanAndEnqueueDiscoveryPage();
    expect(services.prioritizationRepository.getProjection(p.prospectId)).toBeNull();
    expect(domain.processNextDiscoveryJob()).toBe(false);
    expect(domain.getDiscovery().processing).toBe('error');
    expect(services.jobs.get(old.id)).toEqual(failed);
    services.prioritization.recalculateProspect({ evaluationId: 'external-current-proof', prospectId: p.prospectId,
      ruleVersionId: 'founder-priority-v1', evaluatedAt: BOOT_AT, expectedProjectionVersion: null });
    domain.scanAndEnqueueDiscoveryPage();
    expect(domain.getDiscovery().processing).toBe('idle');
    expect(services.jobs.get(old.id)).toEqual({ ...failed, result: { kind: 'discovery_diagnostic_status_v1', status: 'resolved' } });
    // Remove only the synthetic current projection, retaining immutable evidence and command history.
    database.raw.prepare('DELETE FROM prospect_priority_projection WHERE prospect_id = ?').run(p.prospectId);
    domain.scanAndEnqueueDiscoveryPage();
    expect(services.prioritizationRepository.getProjection(p.prospectId)).toBeNull();
    expect(domain.processNextDiscoveryJob()).toBe(false);
    expect(domain.getDiscovery().processing).toBe('error');
    expect(services.jobs.get(old.id)).toEqual({ ...failed, result: { kind: 'discovery_diagnostic_status_v1', status: 'unresolved' } });
    expect(database.raw.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 1 });
    domain.scanAndEnqueueDiscoveryPage();
    expect(services.jobs.get(old.id)).toEqual({ ...failed, result: { kind: 'discovery_diagnostic_status_v1', status: 'unresolved' } });
  });

  it.each(['source', 'rule', 'projection', 'day'] as const)('revalidates %s before executing an older startup refresh command', kind => {
    let at = BOOT_AT;
    const p = seedProspect(database.raw, `changed-${kind}`); const runtime = buildRuntime({ now: () => at }); runtime.initialize();
    const services = runtime.getServices(); const old = services.jobs.listActive()[0]!;
    if (kind === 'day') at = '2026-08-31T12:00:00.000Z';
    const domain = createFounderSalesDomain({ database, services, clock: { now: () => at }, ids: { next: () => `successor-${++runtimeCounter}` } });
    if (kind === 'source') addDirectPhone(p, 'changed-contact');
    if (kind === 'rule') services.unitOfWork.immediate(() => {
      services.prioritizationRepository.installRuleVersion({ ...services.prioritizationRepository.getActiveRuleVersion()!.document, id: 'worker-refresh-v2', version: 2 });
      services.prioritizationRepository.activateRuleVersion({ ruleVersionId: 'worker-refresh-v2', expectedActiveRuleVersionId: 'founder-priority-v1' });
    });
    if (kind === 'projection') services.prioritization.recalculateProspect({ evaluationId: 'newer-projection', prospectId: p.prospectId,
      ruleVersionId: 'founder-priority-v1', evaluatedAt: BOOT_AT, expectedProjectionVersion: null });
    domain.processPriorityRefreshJob(old.id);
    expect(services.jobs.get(old.id)).toMatchObject({ state: 'succeeded', payload: old.payload });
    if (kind !== 'projection') {
      expect(services.prioritizationRepository.getProjection(p.prospectId)).toBeNull();
      expect(domain.processNextDiscoveryJob()).toBe(true);
    }
    const projection = services.prioritizationRepository.getProjection(p.prospectId)!;
    expect(projection.ruleVersionId).toBe(kind === 'rule' ? 'worker-refresh-v2' : 'founder-priority-v1');
    expect(projection.version).toBe(1);
    expect(projection.evaluatedAt).toBe(at);
    if (kind === 'source') expect(projection.reachability).toBe('direct');
    if (kind === 'projection') expect(projection.evaluationId).toBe('newer-projection');
  });

  it('same-local-day restart reuses the exact stored job without duplication', () => {
    seedProspect(database.raw, 'refresh-restart');
    buildRuntime().initialize();
    const report = buildRuntime().initialize();
    expect(report.projectionRefreshCandidateCount).toBe(1);
    expect(report.projectionRebuildsQueued).toBe(0);
    expect(report.pendingProjectionRebuilds).toBe(1);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM jobs WHERE type = ?',
    ).get(PRIORITY_PROJECTION_REBUILD_JOB_TYPE)).toEqual({ count: 1 });
  });

  it('a current same-day projection produces no refresh candidate', () => {
    const prospect = seedProspect(database.raw, 'refresh-current');
    addDirectPhone(prospect, 'refresh-current-phone');
    buildRuntime().initialize();
    const { priorities } = buildPrioritizationStack();
    priorities.recalculateProspect({
      evaluationId: 'refresh-current-eval',
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: BOOT_AT,
      expectedProjectionVersion: null,
    });
    // A fresh restart on the same local day sees a current projection.
    const report = buildRuntime().initialize();
    // The prior missing-projection job predates the recalculation; only the
    // candidate count matters for the fresh scan.
    expect(report.projectionRefreshCandidateCount).toBe(0);
  });

  it('changed relevant input yields a new fingerprint and a second exact job', () => {
    const prospect = seedProspect(database.raw, 'refresh-changed');
    buildRuntime().initialize();
    const first = database.raw.prepare(`
      SELECT idempotency_key FROM jobs WHERE type = ?
    `).get(PRIORITY_PROJECTION_REBUILD_JOB_TYPE) as { idempotency_key: string };
    // A new property changes the qualified-input fingerprint.
    database.raw.prepare(`
      INSERT INTO properties (
        id, address_line_1, locality, region, country_code, door_count,
        created_at, updated_at
      ) VALUES ('refresh-changed-prop', '1 Main', 'Providence', 'RI', 'US', 10, ?, ?)
    `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO prospect_properties (prospect_id, property_id, created_at)
      VALUES (?, 'refresh-changed-prop', ?)
    `).run(prospect.prospectId, DOMAIN_TIMESTAMP);
    const report = buildRuntime().initialize();
    expect(report.projectionRebuildsQueued).toBe(1);
    const keys = database.raw.prepare(`
      SELECT idempotency_key FROM jobs WHERE type = ? ORDER BY created_at
    `).all(PRIORITY_PROJECTION_REBUILD_JOB_TYPE) as { idempotency_key: string }[];
    expect(keys).toHaveLength(2);
    expect(keys[1]!.idempotency_key).not.toBe(first.idempotency_key);
  });

  it('excludes corrupt projections from refresh and reports them as blocking', () => {
    const prospect = seedProspect(database.raw, 'refresh-corrupt');
    addDirectPhone(prospect, 'refresh-corrupt-phone');
    buildRuntime().initialize();
    const { priorities } = buildPrioritizationStack();
    priorities.recalculateProspect({
      evaluationId: 'refresh-corrupt-eval',
      prospectId: prospect.prospectId,
      ruleVersionId: 'founder-priority-v1',
      evaluatedAt: BOOT_AT,
      expectedProjectionVersion: null,
    });
    // Corrupt the stored evaluation result envelope.
    database.raw.exec('DROP TRIGGER immutable_prioritization_evaluations');
    database.raw.prepare(`
      UPDATE prioritization_evaluations SET result_json = 'not-json'
      WHERE id = 'refresh-corrupt-eval'
    `).run();
    database.raw.exec(`
      CREATE TRIGGER immutable_prioritization_evaluations
      BEFORE UPDATE ON prioritization_evaluations
      BEGIN
        SELECT RAISE(ABORT, 'prioritization_evaluations rows are immutable');
      END
    `);
    const report = buildRuntime().initialize();
    expect(report.status).toBe('blocked');
    expect(report.violations).toContainEqual(expect.objectContaining({
      kind: 'priority_projection_corrupt',
      recordId: prospect.prospectId,
    }));
    // No rebuild job was enqueued for the corrupt prospect this run.
    expect(report.projectionRebuildsQueued).toBe(0);
  });

  it('canonical fingerprints are stable under key order', () => {
    expect(fingerprintCanonical({ b: 1, a: 2 })).toBe(fingerprintCanonical({ a: 2, b: 1 }));
    expect(fingerprintCanonical({ a: [1, 2] })).not.toBe(fingerprintCanonical({ a: [2, 1] }));
  });

  it('installs the built-in rule with its exact hash before scanning', () => {
    seedProspect(database.raw, 'refresh-hash');
    buildRuntime().initialize();
    const row = database.raw.prepare(`
      SELECT content_hash FROM prioritization_rule_versions WHERE id = 'founder-priority-v1'
    `).get() as { content_hash: string };
    expect(row.content_hash).toBe(BUILTIN_PRIORITIZATION_RULE_V1.contentHash);
  });
});
