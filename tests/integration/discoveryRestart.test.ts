import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { PRIORITY_PROJECTION_REBUILD_JOB_TYPE, type PriorityProjectionRebuildCommandV1 } from '../../src/main/domain/startup/domainStartupTypes';
import type { DomainServices } from '../../src/main/domain/createDomainServices';
import { createDiscoveryWorker, type DiscoveryWorker } from '../../src/main/discovery/discoveryWorker';
import { unavailableDiscoveryResearch } from '../../src/main/discovery/discoveryResearchPort';
import { seedProspect } from '../fixtures/domainRows';
import { createDiscoveryDatabase, seedDiscoveryOwner, DISCOVERY_NOW, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';

let f: DiscoveryDatabase; let runtime: FoundationRuntime | undefined; let services: DomainServices;
let worker: DiscoveryWorker | undefined;
let callbacks: { run(): void; delay: number; cancelled: boolean }[];
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(DISCOVERY_NOW); f = await createDiscoveryDatabase(); callbacks = []; });
afterEach(async () => { worker?.stop(); await worker?.idle(); await runtime?.shutdown(); f.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function reopen() {
  if (f.database.raw.open) closeDatabase(f.database);
  let domainRuntime!: DomainRuntime;
  runtime = new FoundationRuntime({ appVersion: 'fixture', databasePath: f.temp.path, databaseExists: true,
    keyEnvelopePath: 'fixture:unused', backupDirectory: `${f.temp.path}.backups` }, {
    loadWorkspaceKey: async () => ({ bytes: Buffer.from(f.key.bytes), version: 1 }),
    prepareEncryptedDatabase: async () => undefined, openDatabase: () => openDatabase({ path: f.temp.path, key: f.key }),
    migrateToLatest: async () => ({ fromVersion: 17, toVersion: 17, appliedMigrationIds: [] }),
    createDomainRuntime: database => { domainRuntime = new DomainRuntime({ database,
      clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID } }); return domainRuntime; },
    createHealthService: () => ({ getHealth: () => ({}) as never }), closeDatabase,
  });
  await runtime.initialize(); services = domainRuntime.getServices();
}
function start() {
  worker = createDiscoveryWorker({ domainGate: runtime!, clock: { now: () => new Date().toISOString() },
    research: unavailableDiscoveryResearch, schedule: (run, delay) => {
      const entry = { run, delay, cancelled: false }; callbacks.push(entry); return () => { entry.cancelled = true; };
    } }); worker.start();
}
async function turn() {
  const e = callbacks.find(e => !e.cancelled)!; expect(e).toBeDefined(); e.cancelled = true;
  vi.setSystemTime(Date.now() + e.delay); e.run(); await worker!.idle();
}

describe('encrypted discovery restart and command identity', () => {
  it.each(['assessment', 'priority'].flatMap(family => ['queued', 'running', 'committed', 'missing_after_commit'].map(checkpoint => ({ family, checkpoint }))))('preserves recovery credits and output across $family encrypted $checkpoint checkpoint', async ({ family, checkpoint }) => {
    const assessment = family === 'assessment';
    const owner = assessment ? seedDiscoveryOwner(f, { prefix: 'recovery-reopen', units: 10 }) : seedProspect(f.database.raw, 'recovery-reopen');
    await reopen();
    await runtime!.withDomain(d => d.scanAndEnqueueDiscoveryPage());
    const type = assessment ? 'discovery_assessment' : PRIORITY_PROJECTION_REBUILD_JOB_TYPE;
    const root = services.jobs.listByTypeState(type, 'queued', 50)[0]!;
    const raw = services.unitOfWork.database.raw;
    const field = assessment ? 'source_record_json' : 'observed_at';
    const original = raw.prepare(`SELECT ${field} AS bytes FROM source_events WHERE id = ?`).get(owner.sourceEventId) as { bytes: string };
    const trigger = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'immutable_source_events'").get() as { sql: string };
    raw.exec('DROP TRIGGER immutable_source_events');
    raw.prepare(`UPDATE source_events SET ${field} = ? WHERE id = ?`).run(assessment ? '{}' : 'invalid-time', owner.sourceEventId);
    await runtime!.withDomain(d => { if (assessment) d.processDiscoveryJob(root.id); else d.processPriorityRefreshJob(root.id); });
    const failed = services.jobs.get(root.id)!; expect(failed.error?.code).toBe('invalid_evidence');
    raw.prepare(`UPDATE source_events SET ${field} = ? WHERE id = ?`).run(original.bytes, owner.sourceEventId);
    raw.exec(trigger.sql);
    vi.setSystemTime(Date.now() + 60_000);
    await runtime!.withDomain(d => d.scanAndEnqueueDiscoveryPage());
    const child = services.jobs.listByTypeState(type, 'queued', 50)[0]!;
    expect(child).toMatchObject({ retryCount: 1, payload: { recovery: { rootJobId: root.id } } });
    if (checkpoint !== 'queued') services.jobs.start(child.id, new Date().toISOString());
    let priorOutputId: string | undefined;
    if (checkpoint === 'committed' || checkpoint === 'missing_after_commit') {
      if (assessment) {
        await runtime!.withDomain(d => d.assessDiscoveryProspect(owner.prospectId));
        priorOutputId = services.discoveryRepository.getCurrent(owner.prospectId)!.id;
      } else {
        const command = child.payload as PriorityProjectionRebuildCommandV1;
        services.prioritization.recalculateProspect({ evaluationId: command.evaluationId, prospectId: command.prospectId,
          ruleVersionId: command.ruleVersionId, evaluatedAt: command.evaluatedAt, expectedProjectionVersion: command.expectedProjectionVersion });
        priorOutputId = services.prioritizationRepository.getProjection(owner.prospectId)!.evaluationId;
      }
      if (checkpoint === 'missing_after_commit') raw.prepare(`DELETE FROM ${assessment ? 'discovery_current' : 'prospect_priority_projection'} WHERE prospect_id = ?`).run(owner.prospectId);
    }
    await runtime!.shutdown(); await reopen();
    expect(services.jobs.get(root.id)).toMatchObject({ id: failed.id, state: 'failed', payload: failed.payload, error: failed.error, retryCount: failed.retryCount });
    expect(services.jobs.get(child.id)).toMatchObject({ idempotencyKey: child.idempotencyKey, payload: child.payload, retryCount: 1 });
    start(); await turn(); await turn(); await turn();
    const currentId = assessment ? services.discoveryRepository.getCurrent(owner.prospectId)?.id
      : services.prioritizationRepository.getProjection(owner.prospectId)?.evaluationId;
    expect(currentId).toBeDefined();
    if (checkpoint === 'committed') expect(currentId).toBe(priorOutputId);
    if (checkpoint === 'missing_after_commit') expect(currentId).not.toBe(priorOutputId);
    const completed = services.jobs.get(child.id)!;
    expect(completed.state).toBe('succeeded');
    expect(completed.retryCount).toBe(checkpoint === 'queued' ? 1 : 2);
    if (!assessment && checkpoint === 'missing_after_commit') {
      expect(services.jobs.listByTypeState(type, 'succeeded', 50).map(j => j.retryCount)).toEqual([2, 3]);
      expect(services.prioritizationRepository.getEvaluationById(priorOutputId!)).not.toBeNull();
    }
    expect(await runtime!.withDomain(d => d.getDiscovery().processing)).toBe('idle');
    const historyCount = services.unitOfWork.database.raw.prepare(`SELECT count(*) AS n FROM ${assessment ? 'discovery_assessments' : 'prioritization_evaluations'}`).get();
    await turn();
    expect(services.unitOfWork.database.raw.prepare(`SELECT count(*) AS n FROM ${assessment ? 'discovery_assessments' : 'prioritization_evaluations'}`).get()).toEqual(historyCount);
  });

  it('retains failed diagnostic provenance and resolved status on encrypted reopen, then exposes renewed corruption', async () => {
    const owner = seedProspect(f.database.raw, 'diagnostic-reopen'); await reopen();
    services.prioritization.recalculateProspect({ evaluationId: 'diagnostic-evaluation', prospectId: owner.prospectId,
      ruleVersionId: 'founder-priority-v1', evaluatedAt: DISCOVERY_NOW, expectedProjectionVersion: null });
    const raw = services.unitOfWork.database.raw;
    const original = raw.prepare('SELECT result_json AS bytes FROM prioritization_evaluations WHERE id = ?')
      .get('diagnostic-evaluation') as { bytes: string };
    const trigger = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'immutable_prioritization_evaluations'").get() as { sql: string };
    raw.exec('DROP TRIGGER immutable_prioritization_evaluations');
    raw.prepare("UPDATE prioritization_evaluations SET result_json = 'not-json' WHERE id = ?").run('diagnostic-evaluation');
    start(); await turn();
    const failed = services.jobs.listByTypeState('discovery_assessment', 'failed', 50)[0]!;
    expect(await runtime!.withDomain(d => d.getDiscovery().processing)).toBe('error');
    raw.prepare('UPDATE prioritization_evaluations SET result_json = ? WHERE id = ?').run(original.bytes, 'diagnostic-evaluation');
    await turn();
    expect(await runtime!.withDomain(d => d.getDiscovery().processing)).toBe('idle');
    const resolved = services.jobs.get(failed.id)!;
    expect(resolved).toMatchObject({ state: 'failed', error: failed.error, payload: failed.payload,
      result: { kind: 'discovery_diagnostic_status_v1', status: 'resolved' } });
    raw.exec(trigger.sql);
    worker!.stop(); await worker!.idle(); await runtime!.shutdown(); callbacks = []; await reopen();
    expect(services.jobs.get(failed.id)).toEqual(resolved);
    expect(await runtime!.withDomain(d => d.getDiscovery().processing)).toBe('idle');
    services.unitOfWork.database.raw.exec('DROP TRIGGER immutable_prioritization_evaluations');
    services.unitOfWork.database.raw.prepare("UPDATE prioritization_evaluations SET result_json = 'not-json' WHERE id = ?").run('diagnostic-evaluation');
    start(); await turn(); await turn();
    expect(await runtime!.withDomain(d => d.getDiscovery().processing)).toBe('error');
    expect(services.jobs.get(failed.id)).toMatchObject({ state: 'failed', error: failed.error, payload: failed.payload,
      result: { kind: 'discovery_diagnostic_status_v1', status: 'unresolved' } });
    expect(services.jobs.listByTypeState('discovery_assessment', 'failed', 50)).toHaveLength(1);
  });

  it.each([false, true])('recovers after persistence before completion, changed evidence=%s', async changed => {
    const owner = seedDiscoveryOwner(f, { prefix: 'restart', units: 10 }); await reopen();
    await runtime!.withDomain(d => d.scanAndEnqueueDiscoveryPage());
    const command = services.jobs.listByTypeState('discovery_assessment', 'queued', 50)[0]!;
    await runtime!.withDomain(d => { services.jobs.start(command.id); d.assessDiscoveryProspect(owner.prospectId); });
    const before = services.discoveryRepository.getCurrent(owner.prospectId)!;
    await runtime!.shutdown(); await reopen();
    expect(services.jobs.get(command.id)).toMatchObject({ state: 'failed', error: { code: 'interrupted_by_restart' } });
    if (changed) services.unitOfWork.immediate(() => services.unitOfWork.database.raw.prepare('UPDATE persons SET version = version + 1 WHERE id = ?').run(owner.personId));
    start(); await turn(); await turn();
    const after = services.discoveryRepository.getCurrent(owner.prospectId)!;
    expect(services.jobs.get(command.id)?.state).toBe('succeeded');
    expect(after.id === before.id).toBe(!changed);
    expect(services.jobs.get(command.id)?.payload).toEqual(command.payload);
    expect(services.unitOfWork.database.raw.prepare('SELECT count(*) AS n FROM discovery_assessments').get()).toEqual({ n: changed ? 2 : 1 });
  });

  it('continues an interrupted keyset page without omitting or duplicating owners', async () => {
    for (let i = 0; i < 125; i++) seedDiscoveryOwner(f, { prefix: `page-restart-${i}`, units: 10 });
    await reopen(); start(); await turn();
    const cursor = services.discoveryRepository.readScanCursor(); expect(cursor).not.toBeNull();
    expect(services.jobs.listByTypeState('discovery_assessment', 'succeeded', 50)).toHaveLength(25);
    worker!.stop(); await worker!.idle(); await runtime!.shutdown(); callbacks = []; await reopen();
    expect(services.discoveryRepository.readScanCursor()).toBe(cursor);
    start(); for (let i = 0; i < 4; i++) await turn();
    expect(services.unitOfWork.database.raw.prepare('SELECT count(*) AS n FROM discovery_current').get()).toEqual({ n: 125 });
    expect(services.unitOfWork.database.raw.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 125 });
    expect(services.discoveryRepository.readScanState()).toMatchObject({ cursor: null, lastCompleteLocalDate: '2026-09-06' });
  });
});
