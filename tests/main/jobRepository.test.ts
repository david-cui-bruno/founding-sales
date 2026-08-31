import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  InvalidJobTransitionError,
  JobRepository,
} from '../../src/main/jobs/jobRepository';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

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
    database = openDatabase({ path: tempDatabase.path, key: createTestWorkspaceKey() });
    await migrateToLatest(database);
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
