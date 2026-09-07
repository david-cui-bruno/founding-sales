import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { mapCloudSourceEvent } from '../../src/main/sourcing/intakeMapper';
import { validFrboEvent, validParcelEvent } from '../fixtures/cloudSourceEvents';
import { seedProspect } from '../fixtures/domainRows';
import { PRIORITY_PROJECTION_REBUILD_JOB_TYPE } from '../../src/main/domain/startup/domainStartupTypes';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { createDiscoveryWorker, type DiscoveryWorker } from '../../src/main/discovery/discoveryWorker';
import { unavailableDiscoveryResearch, type DiscoveryResearchPort } from '../../src/main/discovery/discoveryResearchPort';
import { createDiscoveryDatabase, seedDiscoveryOwner, DISCOVERY_NOW, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';

// The scheduler advances only when the test asks. Cancelled callbacks remain capturable.
function scheduler() {
  const entries: { run: () => void; at: number; cancelled: boolean; consumed: boolean }[] = [];
  return {
    schedule(run: () => void, delay: number) {
      const entry = { run, at: Date.now() + delay, cancelled: false, consumed: false }; entries.push(entry);
      return () => { entry.cancelled = true; };
    },
    nextDelay() { const e = entries.find(e => !e.cancelled && !e.consumed); return e ? e.at - Date.now() : null; },
    fire() {
      const e = entries.find(e => !e.cancelled && !e.consumed); expect(e).toBeDefined();
      e!.consumed = true; vi.setSystemTime(Math.max(Date.now(), e!.at)); e!.run();
    },
    async turn(worker: DiscoveryWorker) {
      const e = entries.find(e => !e.cancelled && !e.consumed); expect(e).toBeDefined();
      e!.consumed = true; vi.setSystemTime(Math.max(Date.now(), e!.at)); e!.run(); await worker.idle();
    },
    late() { for (const e of entries) if (!e.consumed) { e.consumed = true; e.run(); } },
  };
}
let f: DiscoveryDatabase;
let runtime: FoundationRuntime;
let worker: DiscoveryWorker | undefined;
let timer: ReturnType<typeof scheduler>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(DISCOVERY_NOW);
  f = await createDiscoveryDatabase(); timer = scheduler();
  let domainRuntime!: DomainRuntime;
  runtime = new FoundationRuntime({ appVersion: 'fixture', databasePath: f.temp.path,
    databaseExists: true, keyEnvelopePath: 'fixture:unused', backupDirectory: `${f.temp.path}.backups` }, {
    loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 42), version: 1 }),
    prepareEncryptedDatabase: async () => undefined, openDatabase: () => f.database,
    migrateToLatest: async () => ({ fromVersion: 17, toVersion: 17, appliedMigrationIds: [] }),
    createDomainRuntime: database => { domainRuntime = new DomainRuntime({ database, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID } }); return domainRuntime; },
    createHealthService: () => ({ getHealth: () => ({}) as never }), closeDatabase: () => undefined,
  });
  await runtime.initialize(); f.services = domainRuntime.getServices();
});
afterEach(async () => {
  worker?.stop(); await worker?.idle(); await runtime.shutdown(); f.close(); worker = undefined;
  vi.restoreAllMocks(); vi.useRealTimers();
});
function makeWorker(research: DiscoveryResearchPort = unavailableDiscoveryResearch) {
  worker = createDiscoveryWorker({ domainGate: runtime, clock: { now: () => new Date().toISOString() },
    research, schedule: timer.schedule });
  return worker;
}
function count(table: string) { return (f.database.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n; }
function jobs() { return f.database.raw.prepare('SELECT type, state, retry_count, payload_json, idempotency_key FROM jobs ORDER BY created_at, id').all(); }

describe('bounded real-runtime local discovery worker', () => {
  it('assesses 125 genuine owners in bounded yielding turns, preserves unrelated jobs and never prepares outbound work', async () => {
    for (let i = 0; i < 125; i++) seedDiscoveryOwner(f, { prefix: `bounded-${i}`, units: 10 });
    f.services.jobs.enqueue({ id: 'unrelated', type: 'sourcing', payload: {}, at: DISCOVERY_NOW });
    const scan = vi.spyOn(f.services.discoveryRepository, 'listScanPage');
    const w = makeWorker(); const gate = vi.spyOn(runtime, 'withDomain');
    w.start(); w.start(); expect(count('discovery_assessments')).toBe(0);
    for (let i = 0; i < 5; i++) {
      const before = count('discovery_assessments'); scan.mockClear(); await timer.turn(w);
      expect(scan.mock.results.reduce((n, r) => n + (r.value?.prospectIds.length ?? 0), 0)).toBeLessThanOrEqual(50);
      expect(count('discovery_assessments') - before).toBe(25);
      expect(count('discovery_assessments')).toBe((i + 1) * 25);
      expect(count('jobs')).toBeLessThanOrEqual(1 + Math.min(125, (i + 1) * 50));
    }
    expect(count('discovery_current')).toBe(125);
    expect(f.services.jobs.get('unrelated')?.state).toBe('queued');
    expect(count('activities')).toBe(0);
    expect(count('next_actions')).toBe(0);
    expect(timer.nextDelay()).toBe(60_000);
    w.stop(); await w.idle(); const touches = gate.mock.calls.length;
    timer.late(); await w.idle(); expect(gate.mock.calls).toHaveLength(touches);
    expect(f.services.discoveryRepository.readScanCursor()).toBeNull();
  });

  it('uses a 60-second completed-pass cadence and notices ingestion without polling-dependent duplicate commands', async () => {
    seedDiscoveryOwner(f, { prefix: 'first', units: null });
    const w = makeWorker(); w.start(); await timer.turn(w); const first = jobs();
    expect(timer.nextDelay()).toBe(60_000);
    await timer.turn(w); expect(jobs()).toEqual(first);
    seedDiscoveryOwner(f, { prefix: 'later', units: 10 });
    await timer.turn(w); expect(count('discovery_current')).toBe(2);
    expect(count('jobs')).toBe(2);
    w.wake(); w.wake(); await timer.turn(w); expect(count('jobs')).toBe(2);
  });

  it('rolls back the entire scanned page and cursor if enqueue fails', async () => {
    seedDiscoveryOwner(f, { prefix: 'atomic-a', units: 10 }); seedDiscoveryOwner(f, { prefix: 'atomic-b', units: 10 });
    await runtime.withDomain(domain => {
      const original = f.services.jobs.enqueue.bind(f.services.jobs); let calls = 0;
      const enqueue = vi.spyOn(f.services.jobs, 'enqueue').mockImplementation(input => {
        if (++calls === 2) throw new Error('injected second enqueue failure'); return original(input);
      });
      expect(() => domain.scanAndEnqueueDiscoveryPage()).toThrow('injected second enqueue failure');
      expect(enqueue).toHaveBeenCalledTimes(2); enqueue.mockRestore();
    });
    expect(count('jobs')).toBe(0); expect(f.services.discoveryRepository.readScanCursor()).toBeNull();
    const w = makeWorker(); w.start(); await timer.turn(w); expect(count('discovery_current')).toBe(2);
  });

  it.each(['enqueue', 'scan', 'delay'] as const)('reports first-page %s failure during backoff, then clears only after recovery', async kind => {
    seedDiscoveryOwner(f, { prefix: 'scan-error-a', units: 10 }); seedDiscoveryOwner(f, { prefix: 'scan-error-b', units: 10 });
    const original = f.services.jobs.enqueue.bind(f.services.jobs); let calls = 0;
    const fail = kind === 'enqueue' ? vi.spyOn(f.services.jobs, 'enqueue').mockImplementation(input => {
      if (++calls === 2) throw new Error('synthetic page failure'); return original(input);
    }) : kind === 'scan' ? vi.spyOn(f.services.discoveryRepository, 'listScanPage').mockImplementation(() => { throw new Error('synthetic scan failure'); })
      : vi.spyOn(f.services.jobs, 'nextDiscoveryDelay').mockImplementation(() => { throw new Error('synthetic pre-job failure'); });
    const w = makeWorker(); w.start(); await timer.turn(w);
    expect(count('jobs')).toBe(0); expect(f.services.discoveryRepository.readScanCursor()).toBeNull();
    expect(f.services.discoveryRepository.readScanState().lastCompleteScanAt).toBeNull();
    expect(timer.nextDelay()).toBe(60_000);
    const changes = f.database.raw.prepare('SELECT total_changes() AS n').get();
    expect(await runtime.withDomain(d => d.getDiscovery().processing)).toBe('error');
    expect(f.database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    fail.mockRestore();
    expect(await runtime.withDomain(d => d.getDiscovery().processing)).toBe('error');
    await timer.turn(w); expect(count('discovery_current')).toBe(2);
    expect(await runtime.withDomain(d => d.getDiscovery().processing)).toBe('idle');
    w.stop(); await w.idle(); const gate = vi.spyOn(runtime, 'withDomain');
    timer.late(); await w.idle(); expect(gate).not.toHaveBeenCalled();
  });

  it('keeps scan failure instance-local and rejects late callbacks after stop and runtime replacement', async () => {
    seedDiscoveryOwner(f, { prefix: 'scan-lifetime', units: 10 });
    const scan = vi.spyOn(f.services.discoveryRepository, 'listScanPage').mockImplementation(() => { throw new Error('synthetic'); });
    const w = makeWorker(); w.start(); await timer.turn(w);
    expect(await runtime.withDomain(d => d.getDiscovery().processing)).toBe('error');
    w.stop(); await w.idle(); scan.mockRestore(); await runtime.shutdown();
    const replacement = new DomainRuntime({ database: f.database, clock: { now: () => DISCOVERY_NOW }, ids: { next: randomUUID } });
    replacement.initialize(); const services = replacement.getServices();
    const domain = createFounderSalesDomain({ database: f.database, services, clock: { now: () => DISCOVERY_NOW }, ids: { next: randomUUID } });
    const gate = vi.spyOn(runtime, 'withDomain'); const before = jobs();
    timer.late(); await w.idle(); expect(gate).not.toHaveBeenCalled(); expect(jobs()).toEqual(before);
    expect(domain.getDiscovery().processing).toBe('idle');
    domain.scanAndEnqueueDiscoveryPage(); expect(domain.processNextDiscoveryJob()).toBe(true);
    expect(domain.getDiscovery().processing).toBe('idle'); replacement.shutdown();
  });

  it('retries transient failures at 1s, 5s and 30s, then stops without starving newer jobs', async () => {
    seedDiscoveryOwner(f, { prefix: 'retry', units: 10 });
    const assess = vi.spyOn(f.services.discovery, 'assess').mockImplementation(() => { throw new Error('Synthetic transient'); });
    const w = makeWorker(); w.start(); await timer.turn(w);
    for (const [delay, retries] of [[1000, 1], [5000, 2], [30000, 3]]) {
      expect(timer.nextDelay()).toBe(delay); await timer.turn(w);
      expect(f.services.jobs.listByTypeState('discovery_assessment', 'failed', 50)[0]?.retryCount).toBe(retries);
    }
    expect(assess).toHaveBeenCalledTimes(4);
    await timer.turn(w); expect(assess).toHaveBeenCalledTimes(4); expect(count('jobs')).toBe(1);
    expect(f.services.discoveryRead.get().processing).toBe('error');
    assess.mockRestore(); seedDiscoveryOwner(f, { prefix: 'after-exhaustion', units: 10 });
    await timer.turn(w); expect(count('discovery_current')).toBe(1);
    expect(f.services.discoveryRead.get().processing).toBe('error');
  });

  it.each(['source', 'rule', 'day', 'dst'] as const)('invalidates %s and persists one fresh deterministic generation', async kind => {
    const owner = seedDiscoveryOwner(f, { prefix: kind, units: 10 });
    const w = makeWorker(); w.start(); await timer.turn(w);
    const before = f.services.discoveryRepository.getCurrent(owner.prospectId)!;
    if (kind === 'source') f.database.raw.prepare('UPDATE persons SET version = version + 1 WHERE id = ?').run(owner.personId);
    if (kind === 'rule') f.services.unitOfWork.immediate(() => {
      const rule = f.services.prioritizationRepository.getActiveRuleVersion()!;
      f.services.prioritizationRepository.installRuleVersion({ ...rule.document, id: 'worker-rule-v2', version: 2 });
      f.services.prioritizationRepository.activateRuleVersion({ ruleVersionId: 'worker-rule-v2', expectedActiveRuleVersionId: rule.id });
    });
    if (kind === 'day') vi.setSystemTime('2026-09-07T04:00:00.000Z');
    if (kind === 'dst') vi.setSystemTime('2026-11-01T04:30:00.000Z');
    await timer.turn(w);
    const after = f.services.discoveryRepository.getCurrent(owner.prospectId)!;
    expect(after.id).not.toBe(before.id);
    expect(after.expiresAt).toBe(kind === 'dst' ? '2026-11-02T05:00:00.000Z' : kind === 'day' ? '2026-09-08T04:00:00.000Z' : '2026-09-07T04:00:00.000Z');
    expect(count('jobs')).toBe(2); await timer.turn(w); expect(count('jobs')).toBe(2);
  });

  it('uses the exact previous same-day trigger expiry as generation and never reuses an expired boundary', async () => {
    const event = validFrboEvent(); event.entity.person = validParcelEvent().entity.person; event.signal_flags.vacancy = true;
    const mapped = mapCloudSourceEvent(event); if (mapped.kind !== 'intake') throw new Error('intake expected');
    const owner = f.services.sources.createPersonProspect(mapped.command);
    f.services.lifecycle.createUnreviewedCycle({ personId: owner.personId, prospectId: owner.prospectId,
      entrySourceEventId: owner.sourceEventId, effectiveAt: DISCOVERY_NOW });
    f.services.prioritization.recordTriggerEvent({ id: randomUUID(), prospectId: owner.prospectId,
      triggerType: 'live_vacancy', effectiveAt: event.observed_at, sourceExpiresAt: '2026-09-06T13:00:00.000Z',
      strengthMultiplier: 1, verificationState: 'unverified', evidence: { formatVersion: 1, triggerType: 'live_vacancy',
        authoredUnderRuleVersionId: 'founder-priority-v1', function: 'decaying', evidenceRefs: [String(event.payload.listing_url)],
        proof: { kind: 'source_event', sourceEventId: owner.sourceEventId, sourceObservedAt: event.observed_at } } });
    const w = makeWorker(); w.start(); await timer.turn(w);
    expect(f.services.discoveryRepository.getCurrent(owner.prospectId)!.expiresAt).toBe('2026-09-06T13:00:00.000Z');
    vi.setSystemTime('2026-09-06T13:00:00.000Z'); await timer.turn(w);
    const a = f.services.discoveryRepository.getCurrent(owner.prospectId)!;
    expect(a.expiresAt).toBe('2026-09-07T04:00:00.000Z'); expect(a.axes.timing.hasSupportedTrigger).toBe(false);
    const payloads = f.services.jobs.listByTypeState('discovery_assessment', 'succeeded', 50).map(j => j.payload);
    expect(payloads).toEqual(expect.arrayContaining([expect.objectContaining({ generation: 'initial' }),
      expect.objectContaining({ generation: '2026-09-06T13:00:00.000Z' })]));
    await timer.turn(w); expect(count('jobs')).toBe(2);
  });

  it('restarts even when stopped and started while a runtime lease admission is pending', async () => {
    seedDiscoveryOwner(f, { prefix: 'restart-flight', units: 10 });
    const w = makeWorker(); w.start();
    const turn = timer.turn(w); w.stop(); w.start(); await turn;
    expect(timer.nextDelay()).toBe(0); await timer.turn(w);
    expect(count('discovery_current')).toBe(1);
  });

  it.each([false, true])('runs optional research outside the lease and validates returned source claims, unsupported=%s', async unsupported => {
    seedDiscoveryOwner(f, { prefix: 'research', units: 10 });
    const research = vi.fn<DiscoveryResearchPort['research']>(async input => {
      expect(f.database.raw.inTransaction).toBe(false); expect(input.signal.aborted).toBe(false);
      expect(input.personId).toBeTruthy(); expect(input.claims.length).toBeGreaterThan(0);
      return unsupported ? [{ ...input.claims[0]!, value: 'fabricated external fact', certainty: 'fact' }] : input.claims;
    });
    const w = makeWorker({ capability: () => 'available', research }); w.start(); await timer.turn(w);
    expect(research).toHaveBeenCalledTimes(1);
    expect(count('discovery_current')).toBe(unsupported ? 0 : 1);
    if (unsupported) expect(f.services.jobs.listByTypeState('discovery_assessment', 'failed', 1)[0]?.error?.code).toBe('invalid_research');
  });

  it.each(['evidence_too_large', 'invalid_evidence'] as const)('keeps %s diagnostic distinct and never endlessly requeues malformed evidence', async code => {
    const owner = seedDiscoveryOwner(f, { prefix: code, units: 10 });
    f.services.sources.appendSourceInteraction({ id: `diagnostic-${code}`, personId: owner.personId, channel: 'parcel',
      observedAt: DISCOVERY_NOW, sourceRecord: code === 'evidence_too_large' ? { raw: 'x'.repeat(1024 * 1024) }
        : { cloudSourceEvent: validFrboEvent() } });
    const w = makeWorker(); w.start(); await timer.turn(w);
    expect(f.services.jobs.listByTypeState('discovery_assessment', 'failed', 1)[0]?.error?.code).toBe(code);
    expect(count('discovery_current')).toBe(0); expect(count('jobs')).toBe(1);
    await timer.turn(w); vi.setSystemTime('2026-09-07T12:00:00.000Z'); await timer.turn(w);
    expect(count('jobs')).toBe(1); expect(f.services.discoveryRead.get().processing).toBe('error');
  });

  it.each(['stop', 'deadline'] as const)('aborts injected research on %s without retaining a lease or accepting a late result', async reason => {
    seedDiscoveryOwner(f, { prefix: reason, units: 10 });
    let entered!: () => void; const admission = new Promise<void>(resolve => { entered = resolve; });
    let resolveResult!: (claims: []) => void;
    const result = new Promise<[]>(resolve => { resolveResult = resolve; });
    let signal!: AbortSignal;
    const w = makeWorker({ capability: () => 'available', research: input => {
      signal = input.signal; expect(f.database.raw.inTransaction).toBe(false); entered(); return result;
    } });
    const gate = vi.spyOn(runtime, 'withDomain'); w.start(); const turn = timer.turn(w); await admission;
    expect(timer.nextDelay()).toBe(15_000);
    if (reason === 'stop') w.stop(); else timer.fire();
    await turn; expect(signal.aborted).toBe(true); expect(count('discovery_current')).toBe(0);
    if (reason === 'deadline') {
      expect(f.services.jobs.listByTypeState('discovery_assessment', 'failed', 1)[0]?.error?.code).toBe('research_timeout');
      expect(timer.nextDelay()).toBe(1000); w.stop();
    }
    const calls = gate.mock.calls.length; resolveResult([]); await result; timer.late(); await w.idle();
    expect(gate.mock.calls).toHaveLength(calls); expect(count('discovery_current')).toBe(0);
  });

  it('revalidates changed evidence after research and assesses only the fresh successor command', async () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'research-change', units: 10 });
    let calls = 0;
    const w = makeWorker({ capability: () => 'available', research: async input => {
      if (++calls === 1) f.database.raw.prepare('UPDATE persons SET version = version + 1 WHERE id = ?').run(owner.personId);
      return input.claims;
    } });
    const assess = vi.spyOn(f.services.discovery, 'assess'); w.start(); await timer.turn(w);
    expect(calls).toBe(2); expect(assess).toHaveBeenCalledTimes(1);
    expect(count('discovery_current')).toBe(1); expect(count('jobs')).toBe(2);
    expect(f.services.jobs.listByTypeState('discovery_assessment', 'succeeded', 50).map(j => j.result))
      .toContainEqual({ status: 'superseded_research' });
  });

  it('refuses a result admitted by another facade runtime epoch even over the same encrypted database', async () => {
    seedDiscoveryOwner(f, { prefix: 'epoch', units: 10 });
    const request = await runtime.withDomain(d => { d.scanAndEnqueueDiscoveryPage(); return d.prepareDiscoveryResearch()!; });
    const replacement = createFounderSalesDomain({ database: f.database, services: f.services,
      clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID } });
    replacement.completeDiscoveryResearch(request, request.claims);
    expect(count('discovery_current')).toBe(0); expect(f.services.jobs.get(request.jobId)?.state).toBe('running');
    await runtime.withDomain(d => d.completeDiscoveryResearch(request, request.claims));
    expect(count('discovery_current')).toBe(1);
  });

  it('recurringly repairs eligible no-cycle Prospects without inventing assessments or cycles', async () => {
    const owner = seedProspect(f.database.raw, 'no-cycle');
    const w = makeWorker(); w.start(); await timer.turn(w);
    expect(f.services.prioritizationRepository.getProjection(owner.prospectId)?.version).toBe(1);
    expect(count('sales_cycles')).toBe(0); expect(count('discovery_assessments')).toBe(0);
    expect(f.services.jobs.listByTypeState('discovery_assessment', 'failed', 50)).toEqual([]);
    vi.setSystemTime('2026-09-07T04:00:00.000Z'); await timer.turn(w);
    expect(f.services.prioritizationRepository.getProjection(owner.prospectId)?.version).toBe(2);
    expect(f.services.jobs.listByTypeState(PRIORITY_PROJECTION_REBUILD_JOB_TYPE, 'succeeded', 50)).toHaveLength(2);
    expect(count('sales_cycles')).toBe(0);
  });

  it('isolates actual corrupt priority evidence, dedupes its diagnostic across days and resumes corrected evidence', async () => {
    const broken = seedProspect(f.database.raw, 'aaa-corrupt'); const healthy = seedProspect(f.database.raw, 'zzz-healthy');
    f.services.prioritization.recalculateProspect({ evaluationId: 'broken-eval', prospectId: broken.prospectId,
      ruleVersionId: 'founder-priority-v1', evaluatedAt: DISCOVERY_NOW, expectedProjectionVersion: null });
    const original = f.database.raw.prepare('SELECT result_json FROM prioritization_evaluations WHERE id = ?').get('broken-eval') as { result_json: string };
    f.database.raw.exec('DROP TRIGGER immutable_prioritization_evaluations');
    f.database.raw.prepare("UPDATE prioritization_evaluations SET result_json = 'not-json' WHERE id = ?").run('broken-eval');
    const w = makeWorker(); w.start(); await timer.turn(w);
    const failed = f.services.jobs.listByTypeState('discovery_assessment', 'failed', 50);
    expect(failed).toHaveLength(1); expect(failed[0]?.error?.code).toBe('invalid_evidence');
    expect(f.services.prioritizationRepository.getProjection(healthy.prospectId)?.version).toBe(1);
    expect(count('discovery_assessments')).toBe(0); expect(f.services.discoveryRepository.readScanCursor()).toBeNull();
    await timer.turn(w); vi.setSystemTime('2026-09-07T04:00:00.000Z'); await timer.turn(w);
    expect(f.services.jobs.listByTypeState('discovery_assessment', 'failed', 50).map(j => j.id)).toEqual([failed[0]!.id]);
    f.database.raw.prepare('UPDATE prioritization_evaluations SET result_json = ? WHERE id = ?').run(original.result_json, 'broken-eval');
    await timer.turn(w);
    expect(f.services.prioritizationRepository.getProjection(broken.prospectId)?.version).toBe(2);
    expect(count('discovery_assessments')).toBe(0);
    expect(f.services.jobs.get(failed[0]!.id)?.state).toBe('failed'); // Historical diagnostic is never a claimed assessment.
    expect(f.services.jobs.get(failed[0]!.id)).toMatchObject({ error: failed[0]!.error, payload: failed[0]!.payload });
    expect(f.services.discoveryRead.get().processing).toBe('idle');
    const repaired = f.services.prioritizationRepository.getProjection(broken.prospectId)!;
    f.database.raw.prepare("UPDATE prioritization_evaluations SET result_json = 'not-json' WHERE id = ?").run(repaired.evaluationId);
    await timer.turn(w); expect(f.services.discoveryRead.get().processing).toBe('error');
    expect(f.services.jobs.listByTypeState('discovery_assessment', 'failed', 50).map(j => j.id)).toEqual([failed[0]!.id]);
    const renewed = f.services.jobs.get(failed[0]!.id); await timer.turn(w);
    expect(f.services.jobs.get(failed[0]!.id)).toEqual(renewed);
  });

  it('resolves only corrected diagnostics while an unresolved neighbor still reports error', async () => {
    const owners = ['resolved-owner', 'unresolved-owner'].map(prefix => seedDiscoveryOwner(f, { prefix, units: 10 }));
    const originals = owners.map(owner => (f.database.raw.prepare('SELECT source_record_json AS bytes FROM source_events WHERE id = ?')
      .get(owner.sourceEventId) as { bytes: string }).bytes);
    f.database.raw.exec('DROP TRIGGER immutable_source_events');
    for (const owner of owners) f.database.raw.prepare('UPDATE source_events SET source_record_json = ? WHERE id = ?')
      .run(JSON.stringify({ raw: 'x'.repeat(1024 * 1024) }), owner.sourceEventId);
    const w = makeWorker(); w.start(); await timer.turn(w);
    const history = f.services.jobs.listByTypeState('discovery_assessment', 'failed', 50);
    expect(history).toHaveLength(2);
    f.database.raw.prepare('UPDATE source_events SET source_record_json = ? WHERE id = ?').run(originals[0], owners[0]!.sourceEventId);
    await timer.turn(w); expect(count('discovery_current')).toBe(1);
    expect(f.services.discoveryRead.get().processing).toBe('error');
    f.database.raw.prepare('UPDATE source_events SET source_record_json = ? WHERE id = ?').run(originals[1], owners[1]!.sourceEventId);
    await timer.turn(w); expect(count('discovery_current')).toBe(2);
    expect(f.services.discoveryRead.get().processing).toBe('idle');
    for (const job of history) expect(f.services.jobs.get(job.id)).toMatchObject({ state: 'failed', payload: job.payload, error: job.error });
  });

  it('does not call a normal failed assessment resolved merely because its original evidence was restored', async () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'restore-normal-command', units: 10 });
    const original = f.database.raw.prepare('SELECT source_record_json AS bytes FROM source_events WHERE id = ?')
      .get(owner.sourceEventId) as { bytes: string };
    f.database.raw.exec('DROP TRIGGER immutable_source_events');
    const w = makeWorker({ capability: () => 'available', research: async input => {
      f.database.raw.prepare("UPDATE source_events SET source_record_json = '{}' WHERE id = ?").run(owner.sourceEventId);
      return input.claims;
    } });
    w.start(); await timer.turn(w); w.stop(); await w.idle();
    const failed = f.services.jobs.listByTypeState('discovery_assessment', 'failed', 50)[0]!;
    expect(failed).toMatchObject({ error: { code: 'invalid_evidence' }, payload: { diagnostic: null } });
    f.database.raw.prepare('UPDATE source_events SET source_record_json = ? WHERE id = ?').run(original.bytes, owner.sourceEventId);
    const local = makeWorker(); local.start(); await timer.turn(local); await timer.turn(local);
    expect(count('discovery_current')).toBe(0);
    expect(f.services.discoveryRead.get().processing).toBe('error');
    expect(f.services.jobs.get(failed.id)).toMatchObject({ state: 'failed', payload: failed.payload, error: failed.error });
    // A separately performed accepted assessment supplies the proof. This worker has not revived the failed command.
    f.services.discovery.assess(owner.prospectId); await timer.turn(local);
    expect(f.services.discoveryRead.get().processing).toBe('idle');
    expect(f.services.jobs.get(failed.id)).toMatchObject({ state: 'failed', payload: failed.payload, error: failed.error,
      result: { kind: 'discovery_diagnostic_status_v1', status: 'resolved' } });
  });

  it('shares the 25-job budget across actual owned types and leaves legacy placeholders and sourcing untouched', async () => {
    for (let i = 0; i < 25; i++) { seedDiscoveryOwner(f, { prefix: `mixed-${i}`, units: 10 }); seedProspect(f.database.raw, `priority-${i}`); }
    const foreign = ['discovery.scan', 'discovery.assess', 'discovery.research', 'priority_projection_rebuild', 'sourcing']
      .map(type => f.services.jobs.enqueue({ type, payload: {}, at: DISCOVERY_NOW }));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No worker networking permitted'));
    const w = makeWorker(); w.start(); await timer.turn(w);
    expect(f.database.raw.prepare("SELECT count(*) AS n FROM jobs WHERE state = 'succeeded'").get()).toEqual({ n: 25 });
    await timer.turn(w);
    expect(f.database.raw.prepare("SELECT count(*) AS n FROM jobs WHERE state = 'succeeded'").get()).toEqual({ n: 50 });
    for (const job of foreign) expect(f.services.jobs.get(job.id)).toEqual(job);
    expect(fetch).not.toHaveBeenCalled(); expect(count('activities')).toBe(0);
  });

  it('backs off rejected runtime admissions without an unhandled rejection or late database entry', async () => {
    const gate = vi.spyOn(runtime, 'withDomain').mockRejectedValueOnce(new Error('Synthetic runtime paused'));
    const w = makeWorker(); w.start(); await timer.turn(w);
    expect(timer.nextDelay()).toBe(60_000); expect(count('jobs')).toBe(0);
    w.stop(); const calls = gate.mock.calls.length; timer.late(); await w.idle();
    expect(gate.mock.calls).toHaveLength(calls);
  });

  it('does not cache a persisted assessment whose fact value fails actual Task3 validation', async () => {
    const owner = seedDiscoveryOwner(f, { prefix: 'invalid-cache', units: 10 });
    f.services.discovery.assess(owner.prospectId);
    const prior = f.services.discoveryRepository.getCurrent(owner.prospectId)!;
    const invalid = { ...prior, id: randomUUID(), claims: prior.claims.map((c, i) => i === 0 ? { ...c, value: 'unsupported fact' } : c) };
    f.services.unitOfWork.immediate(() => { f.services.discoveryRepository.appendAssessment(invalid); f.services.discoveryRepository.setCurrent(owner.prospectId, invalid.id); });
    const w = makeWorker(); w.start(); await timer.turn(w);
    const current = f.services.discoveryRepository.getCurrent(owner.prospectId)!;
    expect(current.id).not.toBe(invalid.id); expect(current.claims).toEqual(prior.claims);
  });

  it.each(['evidence_too_large', 'invalid_evidence'] as const)('retains the original %s diagnostic when fresh research revalidation fails', async code => {
    const owner = seedDiscoveryOwner(f, { prefix: `research-${code}`, units: 10 });
    const w = makeWorker({ capability: () => 'available', research: async input => {
      f.services.sources.appendSourceInteraction({ id: 'changed-during-research', personId: owner.personId, channel: 'parcel',
        observedAt: DISCOVERY_NOW, sourceRecord: code === 'evidence_too_large' ? { raw: 'x'.repeat(1024 * 1024) }
          : { cloudSourceEvent: validFrboEvent() } });
      return input.claims;
    } });
    w.start(); await timer.turn(w);
    expect(f.services.jobs.listByTypeState('discovery_assessment', 'failed', 1)[0]?.error?.code).toBe(code);
    expect(count('discovery_assessments')).toBe(0);
  });

  it('validates scan limits and stored completion state without mutating on read', () => {
    const repo = f.services.discoveryRepository;
    for (const limit of [0, 51, 1.1]) expect(() => repo.listScanPage({ afterProspectId: null, limit })).toThrow();
    expect(() => repo.completeScan(DISCOVERY_NOW, '2026-09-06')).toThrow();
    expect(repo.readScanState()).toEqual({ cursor: null, lastCompleteScanAt: null, lastCompleteLocalDate: null });
    f.services.unitOfWork.immediate(() => repo.completeScan(DISCOVERY_NOW, '2026-09-06'));
    expect(repo.readScanState()).toEqual({ cursor: null, lastCompleteScanAt: DISCOVERY_NOW, lastCompleteLocalDate: '2026-09-06' });
    f.database.raw.pragma('ignore_check_constraints = ON');
    f.database.raw.prepare("UPDATE discovery_scan_state SET last_complete_scan_at = 'bad'").run();
    expect(() => repo.readScanState()).toThrow('corrupt');
  });
});
