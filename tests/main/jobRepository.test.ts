import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  InvalidJobTransitionError,
  JobRepository,
} from '../../src/main/jobs/jobRepository';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { seedProspect } from '../fixtures/domainRows';
import { seedPriorityRebuildJobs } from '../fixtures/priorityRebuildJob';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import type { PriorityProjectionRebuildCommandV1 } from '../../src/main/domain/startup/domainStartupTypes';

describe('JobRepository', () => {
  let database: AppDatabase | undefined;
  let tempDatabase: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) {
      closeDatabase(database);
    }
    tempDatabase?.cleanup();
  });

  async function createRepository(): Promise<JobRepository> {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });
    return new JobRepository(database);
  }

  async function recoveryFixture(retries = 0) {
    const repository = await createRepository();
    const owner = seedProspect(database!.raw, 'recovery-budget');
    const at = '2026-09-06T12:00:00.000Z';
    let id = 0;
    const runtime = new DomainRuntime({ database: database!, clock: { now: () => at }, ids: { next: () => `budget-${++id}` } });
    runtime.initialize();
    // Startup stopped enqueuing rebuild jobs in Batch 10 (D11 step 6a). The root command
    // is seeded with the same functions bootstrap used, after initialize() so its
    // retirement sweep has already run; the ids are the same as before.
    seedPriorityRebuildJobs({ services: runtime.getServices(), asOf: at,
      listEligibleProspectIds: () => [owner.prospectId], nextId: () => `budget-${++id}` });
    const root = repository.listActive()[0]!;
    for (let i = 0; i < retries; i++) {
      repository.start(root.id, at); repository.fail(root.id, { code: 'discovery_transient', message: 'Synthetic transient' }, at);
      repository.retryFailed(root.id, at);
    }
    repository.start(root.id, at); repository.fail(root.id, { code: 'invalid_evidence', message: 'Original invalid evidence' }, at);
    const failed = repository.get(root.id)!;
    const unitOfWork = new DomainUnitOfWork(database!);
    const request = (time = '2026-09-06T12:01:00.000Z') => {
      const next = `budget-${++id}`;
      return { id: next, type: root.type, idempotencyKey: root.idempotencyKey!, at: time,
        payload: { ...root.payload as PriorityProjectionRebuildCommandV1, jobId: next, evaluationId: `${next}-evaluation`, evaluatedAt: time } };
    };
    return { repository, owner, failed, unitOfWork, at, request,
      allocate: (time?: string) => unitOfWork.immediate(() => repository.enqueueDiscoveryRecovery(request(time), unitOfWork)) };
  }

  it.each([0, 1, 2, 3])('shares all prior %s retry credits with deterministic recovery, never resets the root', async used => {
    const f = await recoveryFixture(used);
    const original = database!.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(f.failed.id);
    const child = f.allocate();
    if (used === 3) { expect(child).toBeUndefined(); expect(f.repository.listActive()).toEqual([]); }
    else {
      expect(child?.retryCount).toBe(used + 1);
      expect(f.allocate()).toEqual(child);
      expect(() => f.repository.retryFailed(f.failed.id, '2026-09-06T12:01:00.000Z')).toThrow(InvalidJobTransitionError);
      f.repository.start(child!.id, '2026-09-06T12:01:00.000Z');
      f.repository.fail(child!.id, { code: 'invalid_evidence', message: 'Recovery evidence failed' }, '2026-09-06T12:01:00.000Z');
      const next = f.allocate('2026-09-06T12:02:00.000Z');
      expect(next?.retryCount).toBe(used === 2 ? undefined : used + 2);
    }
    expect(database!.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(f.failed.id)).toEqual(original);
  });

  it('preserves 1s/5s/30s delays, consumes transient credits and never skips into a fresh budget', async () => {
    const f = await recoveryFixture();
    expect(f.allocate(f.at)).toBeUndefined();
    const first = f.allocate('2026-09-06T12:00:01.000Z')!;
    f.repository.start(first.id, '2026-09-06T12:00:01.000Z');
    f.repository.fail(first.id, { code: 'discovery_transient', message: 'Temporary' }, '2026-09-06T12:00:01.000Z');
    expect(f.repository.listDueDiscovery('2026-09-06T12:00:05.999Z', 1)).toEqual([]);
    expect(f.repository.listDueDiscovery('2026-09-06T12:00:06.000Z', 1)[0]?.id).toBe(first.id);
    expect(f.allocate('2026-09-06T12:00:06.000Z')?.id).toBe(first.id);
    f.repository.retryFailed(first.id, '2026-09-06T12:00:06.000Z'); f.repository.start(first.id, '2026-09-06T12:00:06.000Z');
    f.repository.fail(first.id, { code: 'invalid_evidence', message: 'Evidence changed' }, '2026-09-06T12:00:06.000Z');
    expect(f.allocate('2026-09-06T12:00:35.999Z')).toBeUndefined();
    const last = f.allocate('2026-09-06T12:00:36.000Z')!;
    expect(last.retryCount).toBe(3);
    expect(JSON.parse(last.idempotencyKey!).at(-1)).toBe(3);
    expect(() => f.repository.retryFailed(first.id, '2026-09-06T12:00:36.000Z')).toThrow();
    f.repository.start(last.id, '2026-09-06T12:00:36.000Z'); f.repository.succeed(last.id, { recorded: true }, '2026-09-06T12:00:36.000Z');
    expect(f.allocate('2026-09-06T12:02:00.000Z')).toBeUndefined();
    expect(database!.raw.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 3 });
  });

  it('allocates atomically in the exact UOW using only three slot reads and one direct root lookup', async () => {
    const f = await recoveryFixture(); const input = f.request();
    expect(() => f.repository.enqueueDiscoveryRecovery(input, f.unitOfWork)).toThrow();
    expect(() => f.unitOfWork.immediate(() => { f.repository.enqueueDiscoveryRecovery(input, f.unitOfWork); throw new Error('rollback'); })).toThrow('rollback');
    expect(database!.raw.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 1 });
    const prepare = vi.spyOn(database!.raw, 'prepare');
    const first = f.unitOfWork.immediate(() => f.repository.enqueueDiscoveryRecovery(input, f.unitOfWork));
    const queries = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    expect(queries.filter(sql => sql.includes('WHERE type = ? AND idempotency_key = ?'))).toHaveLength(4); // canonical + three slots
    expect(queries.filter(sql => sql.includes('FROM jobs WHERE id = ?'))).toHaveLength(1);
    expect(f.unitOfWork.immediate(() => f.repository.enqueueDiscoveryRecovery(input, f.unitOfWork))).toEqual(first);
    const changes = database!.raw.prepare('SELECT total_changes() AS n').get();
    f.allocate(); expect(database!.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });

  it('retains spent lifetime credits when substantive inputs change and return to the earlier identity', async () => {
    const f = await recoveryFixture();
    for (const minute of [1, 2, 3]) {
      const at = `2026-09-06T12:0${minute}:00.000Z`;
      const child = f.allocate(at)!;
      expect(child.retryCount).toBe(minute);
      f.repository.start(child.id, at); f.repository.succeed(child.id, { recorded: true }, at);
    }
    const changed = f.request('2026-09-06T12:04:00.000Z');
    changed.payload.qualifiedInputFingerprint = 'a'.repeat(64); changed.payload.refreshFingerprint = 'b'.repeat(64);
    changed.idempotencyKey = `priority_projection_rebuild_v1:${f.owner.prospectId}:founder-priority-v1:2026-09-06:${'b'.repeat(64)}`;
    const normal = f.unitOfWork.immediate(() => f.repository.enqueueDiscoveryRecovery(changed, f.unitOfWork))!;
    expect(normal.retryCount).toBe(0); expect(normal.payload).toEqual(changed.payload);
    const before = database!.raw.prepare('SELECT * FROM jobs ORDER BY id').all();
    for (let i = 0; i < 20; i++) expect(f.allocate('2026-09-06T12:05:00.000Z')).toBeUndefined();
    expect(database!.raw.prepare('SELECT * FROM jobs ORDER BY id').all()).toEqual(before);
    expect(before).toHaveLength(5); expect(f.repository.get(f.failed.id)).toEqual(f.failed);
  });

  it.each(['missing_root', 'wrong_family', 'wrong_slot', 'extra_metadata', 'wrong_owner', 'wrong_job_id'])('never hides a resolved recovery row with forged %s', async mutation => {
    const f = await recoveryFixture(); const child = f.allocate()!;
    f.repository.start(child.id, '2026-09-06T12:01:00.000Z');
    f.repository.fail(child.id, { code: 'invalid_evidence', message: 'Child evidence' }, '2026-09-06T12:01:00.000Z');
    f.unitOfWork.immediate(() => f.repository.reconcileDiscoveryDiagnostics({ personId: f.owner.personId,
      prospectId: f.owner.prospectId, scope: 'priority', proof: 'current_result' }, f.unitOfWork));
    expect(f.repository.listUnresolvedDiscoveryFailures(1)).toEqual([]);
    const payload = child.payload as Record<string, unknown>;
    if (mutation === 'missing_root') payload.recovery = { kind: 'discovery_recovery_v1', rootJobId: 'missing' };
    if (mutation === 'extra_metadata') payload.recovery = { ...payload.recovery as object, surprise: true };
    if (mutation === 'wrong_owner') payload.prospectId = 'not-owned';
    if (mutation === 'wrong_job_id') payload.jobId = f.failed.id;
    database!.raw.prepare('UPDATE jobs SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), child.id);
    if (mutation === 'wrong_family') database!.raw.prepare("UPDATE jobs SET type = 'discovery_assessment' WHERE id = ?").run(child.id);
    if (mutation === 'wrong_slot') database!.raw.prepare('UPDATE jobs SET idempotency_key = ? WHERE id = ?')
      .run(JSON.stringify([...JSON.parse(child.idempotencyKey!).slice(0, -1), 4]), child.id);
    // Fail closed, never an empty result/false idle after pre-LIMIT filtering.
    expect(() => f.repository.listUnresolvedDiscoveryFailures(1)).toThrow();
  });

  it.each(['key', 'owner', 'job_id', 'evaluation_id', 'metadata', 'root_payload', 'root_id'])('rejects forged recovery admission %s without writes', async mutation => {
    const f = await recoveryFixture(); const request = f.request();
    if (mutation === 'key') request.idempotencyKey = 'not-the-canonical-key';
    if (mutation === 'owner') request.payload.prospectId = 'not-the-owner';
    if (mutation === 'job_id') request.payload.jobId = f.failed.id;
    if (mutation === 'evaluation_id') request.payload.evaluationId = (f.failed.payload as PriorityProjectionRebuildCommandV1).evaluationId;
    if (mutation === 'metadata') Object.assign(request.payload, { recovery: { kind: 'discovery_recovery_v1', rootJobId: f.failed.id } });
    if (mutation === 'root_payload') database!.raw.prepare("UPDATE jobs SET payload_json = '{}' WHERE id = ?").run(f.failed.id);
    if (mutation === 'root_id') database!.raw.prepare('UPDATE jobs SET id = ?, payload_json = ? WHERE id = ?')
      .run(' noncanonical-root ', JSON.stringify({ ...f.failed.payload as object, jobId: ' noncanonical-root ' }), f.failed.id);
    const before = database!.raw.prepare('SELECT * FROM jobs').all();
    expect(() => f.unitOfWork.immediate(() => f.repository.enqueueDiscoveryRecovery(request, f.unitOfWork))).toThrow();
    expect(database!.raw.prepare('SELECT * FROM jobs').all()).toEqual(before);
  });

  it.each(['invalid_command', 'invalid_research', 'discovery_transient', 'cancelled', 'succeeded'])('never creates a new lineage for unrelated terminal %s', async state => {
    const f = await recoveryFixture();
    if (state === 'cancelled') database!.raw.prepare("UPDATE jobs SET state = 'cancelled', started_at = NULL, error_code = NULL, error_message = NULL WHERE id = ?").run(f.failed.id);
    else if (state === 'succeeded') database!.raw.prepare("UPDATE jobs SET state = 'succeeded', error_code = NULL, error_message = NULL, result_json = '{}' WHERE id = ?").run(f.failed.id);
    else database!.raw.prepare('UPDATE jobs SET error_code = ?, retry_count = 3 WHERE id = ?').run(state, f.failed.id);
    const before = database!.raw.prepare('SELECT * FROM jobs').all();
    f.allocate(); expect(database!.raw.prepare('SELECT * FROM jobs').all()).toEqual(before);
  });

  it('rejects a different encrypted database UOW before allocating recovery', async () => {
    const f = await recoveryFixture(); const temp = createTempDatabase(); const key = createTestWorkspaceKey();
    const other = openDatabase({ path: temp.path, key }); const uow = new DomainUnitOfWork(other);
    try {
      expect(() => uow.immediate(() => f.repository.enqueueDiscoveryRecovery(f.request(), uow))).toThrow('DISCOVERY_RECOVERY_DATABASE_MISMATCH');
      expect(database!.raw.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 1 });
    } finally { closeDatabase(other); key.bytes.fill(0); temp.cleanup(); }
  });

  it('refuses direct retry revival of a canonical evidence root and its evidence-failed successor', async () => {
    const f = await recoveryFixture();
    expect(() => f.repository.retryFailed(f.failed.id, '2026-09-06T12:01:00.000Z')).toThrow(InvalidJobTransitionError);
    const child = f.allocate()!;
    f.repository.start(child.id, '2026-09-06T12:01:00.000Z');
    f.repository.fail(child.id, { code: 'invalid_evidence', message: 'Keep this diagnostic' }, '2026-09-06T12:01:00.000Z');
    const failed = f.repository.get(child.id)!;
    expect(() => f.repository.retryFailed(child.id, '2026-09-06T12:02:00.000Z')).toThrow(InvalidJobTransitionError);
    expect(f.repository.get(child.id)).toEqual(failed); expect(f.repository.get(f.failed.id)).toEqual(f.failed);
  });

  it('rejects a consumed-evaluation handoff without a real admitted running lineage even for a new canonical key', async () => {
    const f = await recoveryFixture(); const input = f.request();
    input.payload.qualifiedInputFingerprint = 'a'.repeat(64); input.payload.refreshFingerprint = 'b'.repeat(64);
    input.idempotencyKey = `priority_projection_rebuild_v1:${f.owner.prospectId}:founder-priority-v1:2026-09-06:${'b'.repeat(64)}`;
    expect(() => f.unitOfWork.immediate(() => f.repository.enqueueDiscoveryRecovery(input, f.unitOfWork, 'not-a-consumed-job'))).toThrow();
    expect(database!.raw.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 1 });
  });

  function insertStoredJob(overrides: {
    id: string;
    state?: string;
    progressCurrent?: number;
    progressTotal?: number | null;
    payloadJson?: string;
    resultJson?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    createdAt?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    updatedAt?: string;
  }): void {
    const rawDatabase = database?.raw;
    if (rawDatabase === undefined) {
      throw new Error('Test database is not initialized.');
    }

    const timestamp = '2026-08-29T00:00:00.000Z';
    rawDatabase
      .prepare(
        `INSERT INTO jobs (
          id, type, state, progress_current, progress_total, retry_count, payload_json,
          result_json, error_code, error_message, created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        overrides.id,
        'sync',
        overrides.state ?? 'queued',
        overrides.progressCurrent ?? 0,
        overrides.progressTotal ?? null,
        0,
        overrides.payloadJson ?? '{}',
        overrides.resultJson ?? null,
        overrides.errorCode ?? null,
        overrides.errorMessage ?? null,
        overrides.createdAt ?? timestamp,
        overrides.startedAt ?? null,
        overrides.finishedAt ?? null,
        overrides.updatedAt ?? timestamp,
      );
  }

  it('lists only bounded owned state in stable order and retries the identical failed command three times', async () => {
    const repository = await createRepository(); const at = '2026-09-06T12:00:00.000Z';
    for (const id of ['b', 'a']) repository.enqueue({ id, type: 'discovery_assessment', payload: { id }, idempotencyKey: id, at });
    repository.enqueue({ id: 'foreign', type: 'other', payload: {}, at });
    expect(repository.listByTypeState('discovery_assessment', 'queued', 1).map(j => j.id)).toEqual(['a']);
    for (const limit of [0, 51, 1.5]) expect(() => repository.listByTypeState('discovery_assessment', 'queued', limit)).toThrow();
    expect(() => repository.listByTypeState('other' as never, 'queued', 1)).toThrow();
    const original = repository.get('a')!;
    expect(() => repository.retryFailed('a', at)).toThrow(InvalidJobTransitionError);
    for (let retry = 1; retry <= 3; retry++) {
      repository.start('a'); repository.fail('a', { code: 'transient', message: 'Synthetic' });
      expect(() => repository.retryFailed('a', '2026-09-06T12:00:00Z')).toThrow();
      expect(repository.retryFailed('a', at)).toMatchObject({ id: 'a', state: 'queued', retryCount: retry,
        payload: original.payload, idempotencyKey: original.idempotencyKey, error: null, result: null, updatedAt: at });
      expect(database!.raw.prepare('SELECT started_at, finished_at FROM jobs WHERE id = ?').get('a')).toEqual({ started_at: null, finished_at: null });
    }
    repository.start('a'); repository.fail('a', { code: 'transient', message: 'Synthetic' });
    expect(() => repository.retryFailed('a', at)).toThrow(InvalidJobTransitionError);
    repository.start('foreign'); repository.fail('foreign', { code: 'transient', message: 'Synthetic' });
    expect(() => repository.retryFailed('foreign', at)).toThrow(InvalidJobTransitionError);
  });

  it('reconciles only bounded matching diagnostic history, preserving its failure and exposing unresolved rows before LIMIT', async () => {
    const repository = await createRepository(); const at = '2026-09-06T12:00:00.000Z';
    const uow = new DomainUnitOfWork(database!);
    const owner = seedProspect(database!.raw, 'diagnostic-owner');
    const input = { personId: owner.personId, prospectId: owner.prospectId, scope: 'assessment' as const, proof: 'current_result' as const };
    for (let i = 0; i < 55; i++) {
      const id = `diagnostic-${i.toString().padStart(2, '0')}`;
      repository.enqueue({ id, type: 'discovery_assessment', payload: { formatVersion: 1, personId: owner.personId, prospectId: owner.prospectId }, at });
      repository.start(id, at); repository.fail(id, { code: 'invalid_evidence', message: 'Original diagnostic.' }, at);
    }
    const before = repository.get('diagnostic-00')!;
    expect(() => repository.reconcileDiscoveryDiagnostics(input, uow)).toThrow();
    uow.immediate(() => repository.reconcileDiscoveryDiagnostics({ ...input, personId: 'other' }, uow));
    expect(repository.get(before.id)).toEqual(before);
    expect(() => uow.immediate(() => { repository.reconcileDiscoveryDiagnostics(input, uow); throw new Error('rollback'); })).toThrow('rollback');
    expect(repository.get(before.id)).toEqual(before);
    uow.immediate(() => repository.reconcileDiscoveryDiagnostics(input, uow));
    expect(repository.listUnresolvedDiscoveryFailures(1).map(j => j.id)).toEqual(['diagnostic-50']);
    expect(repository.get(before.id)).toEqual({ ...before, result: { kind: 'discovery_diagnostic_status_v1', status: 'resolved' } });
    uow.immediate(() => repository.reconcileDiscoveryDiagnostics(input, uow));
    expect(repository.listUnresolvedDiscoveryFailures(50)).toEqual([]);
    const changes = database!.raw.prepare('SELECT total_changes() AS n').get();
    uow.immediate(() => repository.reconcileDiscoveryDiagnostics(input, uow));
    expect(database!.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    uow.immediate(() => repository.reconcileDiscoveryDiagnostics({ ...input, proof: 'invalid' }, uow));
    expect(repository.listUnresolvedDiscoveryFailures(1).map(j => j.id)).toEqual([before.id]);
    expect(repository.get(before.id)).toEqual({ ...before, result: { kind: 'discovery_diagnostic_status_v1', status: 'unresolved' } });
    for (const limit of [0, 51, 1.5]) expect(() => repository.listUnresolvedDiscoveryFailures(limit)).toThrow();
    expect(() => repository.succeed(before.id, {})).toThrow(InvalidJobTransitionError);
    expect(() => repository.cancel(before.id)).toThrow(InvalidJobTransitionError);
  });

  it('does not hide unrelated, transient, malformed or forged diagnostic metadata', async () => {
    const repository = await createRepository(); const at = '2026-09-06T12:00:00.000Z'; const uow = new DomainUnitOfWork(database!);
    const owner = seedProspect(database!.raw, 'diagnostic-negative');
    for (const [id, type, code] of [['foreign', 'other', 'invalid_evidence'], ['transient', 'discovery_assessment', 'discovery_transient'],
      ['malformed', 'discovery_assessment', 'invalid_evidence']]) {
      repository.enqueue({ id, type: type!, payload: id === 'malformed' ? {} : { formatVersion: 1, personId: owner.personId, prospectId: owner.prospectId }, at });
      repository.start(id!, at); repository.fail(id!, { code: code!, message: 'Original.' }, at);
    }
    uow.immediate(() => repository.reconcileDiscoveryDiagnostics({ personId: owner.personId, prospectId: owner.prospectId,
      scope: 'assessment', proof: 'current_result' }, uow));
    for (const id of ['foreign', 'transient', 'malformed']) expect(repository.get(id)?.result).toBeNull();
    expect(repository.listUnresolvedDiscoveryFailures(50).map(j => j.id)).toEqual(['malformed', 'transient']);
    database!.raw.prepare('UPDATE jobs SET result_json = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'discovery_diagnostic_status_v1', status: 'resolved' }), 'malformed');
    expect(() => repository.get('malformed')).toThrow();
    expect(() => repository.listUnresolvedDiscoveryFailures(50)).toThrow();
  });

  it.each(['assessment', 'priority'] as const)('revokes normal %s resolution when current proof disappears while stable diagnostics retain valid-evidence proof', async scope => {
    const repository = await createRepository(); const at = '2026-09-06T12:00:00.000Z';
    const uow = new DomainUnitOfWork(database!); const owner = seedProspect(database!.raw, `proof-${scope}`);
    const identity = { formatVersion: 1, personId: owner.personId, prospectId: owner.prospectId };
    const normal: Record<string, unknown> = scope === 'assessment' ? { ...identity, diagnostic: null, fingerprint: 'a'.repeat(64), salesCycleId: 'cycle' }
      : { formatVersion: 1, jobId: 'normal', prospectId: owner.prospectId };
    const stable: Record<string, unknown> = scope === 'assessment' ? { ...identity, diagnostic: 'invalid_evidence', fingerprint: null, salesCycleId: null }
      : { ...identity, kind: 'priority_diagnostic', diagnostic: 'invalid_evidence' };
    for (const [id, payload] of [['normal', normal], ['stable', stable]] as const) {
      repository.enqueue({ id, type: id === 'normal' && scope === 'priority' ? 'priority_projection_rebuild_v1' : 'discovery_assessment', payload, at });
      repository.start(id, at); repository.fail(id, { code: 'invalid_evidence', message: 'Original diagnostic.' }, at);
    }
    const originals = ['normal', 'stable'].map(id => repository.get(id)!);
    const reconcile = (proof: 'invalid' | 'valid_evidence' | 'current_result') => uow.immediate(() =>
      repository.reconcileDiscoveryDiagnostics({ personId: owner.personId, prospectId: owner.prospectId, scope, proof }, uow));
    reconcile('invalid'); expect(originals.map(j => repository.get(j.id))).toEqual(originals);
    reconcile('valid_evidence');
    expect(repository.get('normal')).toEqual(originals[0]);
    expect(repository.get('stable')?.result).toMatchObject({ status: 'resolved' });
    reconcile('current_result'); expect(repository.get('normal')?.result).toMatchObject({ status: 'resolved' });
    reconcile('valid_evidence');
    expect(repository.get('normal')).toEqual({ ...originals[0], result: { kind: 'discovery_diagnostic_status_v1', status: 'unresolved' } });
    expect(repository.get('stable')).toEqual({ ...originals[1], result: { kind: 'discovery_diagnostic_status_v1', status: 'resolved' } });
    reconcile('invalid');
    for (const original of originals) expect(repository.get(original.id)).toEqual({ ...original,
      result: { kind: 'discovery_diagnostic_status_v1', status: 'unresolved' } });
    reconcile('valid_evidence'); reconcile('current_result');
    const changes = database!.raw.prepare('SELECT total_changes() AS n').get();
    reconcile('current_result'); expect(database!.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    for (const original of originals) expect(repository.get(original.id)).toEqual({ ...original,
      result: { kind: 'discovery_diagnostic_status_v1', status: 'resolved' } });
  });

  it('shares one 50-row budget across opposite normal/recovery/stable proof changes with rollback and no churn', async () => {
    const repository = await createRepository(); const at = '2026-09-06T12:00:00.000Z';
    const uow = new DomainUnitOfWork(database!); const owner = seedProspect(database!.raw, 'mixed-proof-budget');
    const input = { personId: owner.personId, prospectId: owner.prospectId, scope: 'priority' as const, proof: 'valid_evidence' as const };
    for (const stable of [false, true]) {
      for (let i = stable ? 1 : 0; i < 80; i += 2) {
        const id = `mixed-${i.toString().padStart(2, '0')}`;
        const fingerprint = Math.floor(i / 4).toString(16).padStart(64, '0');
        const child = !stable && i % 4 === 2;
        const payload: Record<string, unknown> = stable
          ? { formatVersion: 1, personId: owner.personId, prospectId: owner.prospectId, kind: 'priority_diagnostic', diagnostic: 'invalid_evidence' }
          : { formatVersion: 1, jobId: id, evaluationId: `${id}-evaluation`, prospectId: owner.prospectId,
            ruleVersionId: 'founder-priority-v1', founderTimezone: 'America/New_York', founderLocalDate: '2026-09-06',
            evaluatedAt: at, expectedProjectionVersion: null, qualifiedInputFingerprint: fingerprint,
            refreshFingerprint: fingerprint, reasons: ['missing_projection'] };
        if (child) payload.recovery = { kind: 'discovery_recovery_v1', rootJobId: `mixed-${(i - 2).toString().padStart(2, '0')}` };
        repository.enqueue({ id, type: stable ? 'discovery_assessment' : 'priority_projection_rebuild_v1',
          idempotencyKey: stable ? undefined : child
            ? JSON.stringify(['discovery_recovery_v1', 'priority_projection_rebuild_v1', owner.prospectId, 'founder-priority-v1', '2026-09-06', fingerprint, 1])
            : `priority_projection_rebuild_v1:${owner.prospectId}:founder-priority-v1:2026-09-06:${fingerprint}`, payload, at });
        if (child) database!.raw.prepare('UPDATE jobs SET retry_count = 1 WHERE id = ?').run(id);
        repository.start(id, at); repository.fail(id, { code: 'invalid_evidence', message: 'Original mixed diagnostic.' }, at);
      }
      if (!stable) uow.immediate(() => repository.reconcileDiscoveryDiagnostics({ ...input, proof: 'current_result' }, uow));
    }
    const before = Array.from({ length: 80 }, (_, i) => repository.get(`mixed-${i.toString().padStart(2, '0')}`)!);
    const provenanceQuery = database!.raw.prepare(`SELECT id, type, idempotency_key, state, payload_json, error_code, error_message,
      created_at, started_at, finished_at, updated_at, progress_current, progress_total, retry_count FROM jobs ORDER BY id`);
    const provenance = provenanceQuery.all();
    expect(() => uow.immediate(() => { repository.reconcileDiscoveryDiagnostics(input, uow); throw new Error('rollback mixed'); })).toThrow('rollback mixed');
    expect(before.map(j => repository.get(j.id))).toEqual(before);
    uow.immediate(() => repository.reconcileDiscoveryDiagnostics(input, uow));
    before.forEach((job, i) => expect(repository.get(job.id)).toEqual(i >= 50 ? job : { ...job,
      result: { kind: 'discovery_diagnostic_status_v1', status: i % 2 ? 'resolved' : 'unresolved' } }));
    uow.immediate(() => repository.reconcileDiscoveryDiagnostics(input, uow));
    before.forEach((job, i) => expect(repository.get(job.id)).toEqual({ ...job,
      result: { kind: 'discovery_diagnostic_status_v1', status: i % 2 ? 'resolved' : 'unresolved' } }));
    const changes = database!.raw.prepare('SELECT total_changes() AS n').get();
    uow.immediate(() => repository.reconcileDiscoveryDiagnostics(input, uow));
    expect(database!.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(provenanceQuery.all()).toEqual(provenance);
  });

  it('moves a queued job through running to succeeded', async () => {
    const repository = await createRepository();

    const queued = repository.enqueue({
      id: 'job-success',
      type: 'sync',
      payload: { accountId: 'acct_123' },
      progressTotal: 2,
    });
    const running = repository.start(queued.id);
    const progressed = repository.reportProgress(running.id, 1);
    const succeeded = repository.succeed(progressed.id, { imported: 2 });

    expect(queued).toMatchObject({
      id: 'job-success',
      type: 'sync',
      state: 'queued',
      progressCurrent: 0,
      progressTotal: 2,
      retryCount: 0,
      payload: { accountId: 'acct_123' },
      result: null,
      error: null,
    });
    expect(running.state).toBe('running');
    expect(progressed).toMatchObject({ state: 'running', progressCurrent: 1, progressTotal: 2 });
    expect(succeeded).toMatchObject({
      state: 'succeeded',
      progressCurrent: 1,
      progressTotal: 2,
      result: { imported: 2 },
      error: null,
    });
    expect(succeeded.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(succeeded.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('cancels a queued job', async () => {
    const repository = await createRepository();
    const queued = repository.enqueue({ id: 'job-cancel', type: 'sync', payload: {} });

    expect(repository.cancel(queued.id)).toMatchObject({ state: 'cancelled', result: null, error: null });
  });

  it('fails a running job with its structured error', async () => {
    const repository = await createRepository();
    const queued = repository.enqueue({ id: 'job-fail', type: 'sync', payload: {} });
    repository.start(queued.id);

    expect(repository.fail(queued.id, { code: 'network_error', message: 'Connection lost' })).toMatchObject({
      state: 'failed',
      result: null,
      error: { code: 'network_error', message: 'Connection lost' },
    });
  });

  it('rejects all transitions from a terminal job', async () => {
    const repository = await createRepository();
    const queued = repository.enqueue({ id: 'job-terminal', type: 'sync', payload: {} });
    repository.cancel(queued.id);

    expect(() => repository.start(queued.id)).toThrow(InvalidJobTransitionError);
    expect(() => repository.reportProgress(queued.id, 1)).toThrow(InvalidJobTransitionError);
    expect(() => repository.succeed(queued.id, {})).toThrow(InvalidJobTransitionError);
    expect(() => repository.fail(queued.id, { code: 'error', message: 'Error' })).toThrow(
      InvalidJobTransitionError,
    );
    expect(() => repository.cancel(queued.id)).toThrow(InvalidJobTransitionError);
  });

  it('rejects progress outside the requested bounds without changing the job', async () => {
    const repository = await createRepository();
    const queued = repository.enqueue({ id: 'job-progress', type: 'sync', payload: {}, progressTotal: 3 });
    repository.start(queued.id);

    expect(() => repository.reportProgress(queued.id, -1)).toThrow();
    expect(() => repository.reportProgress(queued.id, 4)).toThrow(InvalidJobTransitionError);
    expect(() => repository.reportProgress(queued.id, 2, 1)).toThrow();
    expect(repository.get(queued.id)).toMatchObject({
      state: 'running',
      progressCurrent: 0,
      progressTotal: 3,
    });
  });

  it('preserves unknown payload keys through JSON storage', async () => {
    const repository = await createRepository();
    const payload = {
      source: 'crm',
      futureOption: { enabled: true, retries: [1, 2, 3] },
    };

    repository.enqueue({ id: 'job-payload', type: 'sync', payload });

    expect(repository.get('job-payload')?.payload).toEqual(payload);
  });

  it('returns the canonical job for the same type and idempotency key', async () => {
    const repository = await createRepository();
    const first = repository.enqueue({
      id: 'job-canonical',
      type: 'rebuild-projection',
      idempotencyKey: 'prospect-123:v1',
      payload: { prospectId: 'prospect-123', attempt: 1 },
    });
    const duplicate = repository.enqueue({
      id: 'job-duplicate',
      type: 'rebuild-projection',
      idempotencyKey: 'prospect-123:v1',
      payload: { prospectId: 'prospect-123', attempt: 2 },
    });
    const exactRetry = repository.enqueue({
      id: 'job-canonical',
      type: 'rebuild-projection',
      idempotencyKey: 'prospect-123:v1',
      payload: { prospectId: 'prospect-123', attempt: 3 },
    });

    expect(duplicate).toEqual(first);
    expect(exactRetry).toEqual(first);
    expect(first).toMatchObject({
      id: 'job-canonical',
      idempotencyKey: 'prospect-123:v1',
      payload: { prospectId: 'prospect-123', attempt: 1 },
    });
    expect(database?.raw.prepare<[], { count: number }>(`
      SELECT COUNT(*) AS count FROM jobs WHERE type = 'rebuild-projection'
    `).get()).toEqual({ count: 1 });
  });

  it('scopes idempotency keys to job type and leaves unkeyed jobs independent', async () => {
    const repository = await createRepository();
    const first = repository.enqueue({
      id: 'job-type-one',
      type: 'type-one',
      idempotencyKey: 'same-key',
      payload: {},
    });
    const second = repository.enqueue({
      id: 'job-type-two',
      type: 'type-two',
      idempotencyKey: 'same-key',
      payload: {},
    });
    const unkeyedOne = repository.enqueue({ id: 'job-unkeyed-one', type: 'type-one', payload: {} });
    const unkeyedTwo = repository.enqueue({ id: 'job-unkeyed-two', type: 'type-one', payload: {} });

    expect([first.id, second.id, unkeyedOne.id, unkeyedTwo.id]).toEqual([
      'job-type-one',
      'job-type-two',
      'job-unkeyed-one',
      'job-unkeyed-two',
    ]);
  });

  it('does not hide an unrelated primary-key collision behind idempotency lookup', async () => {
    const repository = await createRepository();
    repository.enqueue({ id: 'job-collision', type: 'first-type', payload: {} });

    expect(() => repository.enqueue({
      id: 'job-collision',
      type: 'second-type',
      idempotencyKey: 'new-key',
      payload: {},
    })).toThrow();
    expect(repository.get('job-collision')).toMatchObject({ type: 'first-type' });
  });

  it('rejects an empty idempotency key before persistence', async () => {
    const repository = await createRepository();

    expect(() => repository.enqueue({
      id: 'job-empty-idempotency',
      type: 'sync',
      idempotencyKey: '',
      payload: {},
    })).toThrow(z.ZodError);
    expect(repository.get('job-empty-idempotency')).toBeNull();
  });

  it('rejects an empty supplied id before it can be persisted', async () => {
    const repository = await createRepository();
    const rawDatabase = database?.raw;
    if (rawDatabase === undefined) {
      throw new Error('Test database is not initialized.');
    }

    expect(() => repository.enqueue({ id: '', type: 'sync', payload: {} })).toThrow(z.ZodError);
    expect(
      rawDatabase
        .prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM jobs WHERE id = ?')
        .get(''),
    ).toEqual({ count: 0 });
  });

  it('recovers running jobs as interrupted failures after a restart', async () => {
    const repository = await createRepository();
    const running = repository.enqueue({ id: 'job-recover', type: 'sync', payload: {} });
    const queued = repository.enqueue({ id: 'job-stay-queued', type: 'sync', payload: {} });
    repository.start(running.id);

    expect(repository.recoverInterruptedJobs()).toBe(1);
    expect(repository.get(running.id)).toMatchObject({
      state: 'failed',
      error: {
        code: 'interrupted_by_restart',
        message: 'Job interrupted by application restart.',
      },
    });
    expect(repository.get(queued.id)?.state).toBe('queued');
  });

  const malformedRows = [
    ['negative progress', { id: 'job-negative-progress', progressCurrent: -1 }],
    ['invalid payload JSON', { id: 'job-invalid-json', payloadJson: '{not-json' }],
    [
      'invalid result JSON',
      {
        id: 'job-invalid-result-json',
        state: 'succeeded',
        resultJson: '{not-json',
        startedAt: '2026-08-29T00:00:00.000Z',
        finishedAt: '2026-08-29T00:01:00.000Z',
      },
    ],
    ['non-UTC timestamp', { id: 'job-offset-timestamp', createdAt: '2026-08-29T00:00:00.000+00:00' }],
    ['active job result', { id: 'job-queued-result', resultJson: '{"unexpected":true}' }],
    [
      'succeeded job without result',
      {
        id: 'job-succeeded-without-result',
        state: 'succeeded',
        startedAt: '2026-08-29T00:00:00.000Z',
        finishedAt: '2026-08-29T00:01:00.000Z',
      },
    ],
    [
      'failed job without error',
      {
        id: 'job-failed-without-error',
        state: 'failed',
        startedAt: '2026-08-29T00:00:00.000Z',
        finishedAt: '2026-08-29T00:01:00.000Z',
      },
    ],
    ['running job without start timestamp', { id: 'job-running-without-start', state: 'running' }],
    [
      'cancelled job with start timestamp',
      {
        id: 'job-cancelled-with-start',
        state: 'cancelled',
        startedAt: '2026-08-29T00:00:00.000Z',
        finishedAt: '2026-08-29T00:01:00.000Z',
      },
    ],
  ] as const;

  for (const [description, row] of malformedRows) {
    it(`rejects a persisted record with ${description} through Zod validation`, async () => {
      const repository = await createRepository();
      insertStoredJob(row);

      expect(() => repository.get(row.id)).toThrow(z.ZodError);
    });
  }
});
