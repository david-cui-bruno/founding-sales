import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  InvalidJobTransitionError,
  JobRepository,
} from '../../src/main/jobs/jobRepository';
import { createTempDatabase, type TempDatabase } from '../fixtures/tempDatabase';

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
    database = openDatabase(tempDatabase.path);
    await migrateToLatest(database);
    return new JobRepository(database);
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

  it('does not expose malformed stored rows as records', async () => {
    const repository = await createRepository();
    const timestamp = '2026-08-29T00:00:00.000Z';
    database?.raw
      .prepare(
        `INSERT INTO jobs (
          id, type, state, progress_current, progress_total, retry_count, payload_json,
          result_json, error_code, error_message, created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'job-malformed',
        'sync',
        'queued',
        -1,
        null,
        0,
        '{}',
        null,
        null,
        null,
        timestamp,
        null,
        null,
        timestamp,
      );

    expect(() => repository.get('job-malformed')).toThrow();
  });
});
