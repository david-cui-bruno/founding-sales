import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
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
