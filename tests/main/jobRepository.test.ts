import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  InvalidJobTransitionError,
  JobRepository,
} from '../../src/main/jobs/jobRepository';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { seedProspect } from '../fixtures/domainRows';

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
