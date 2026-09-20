import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { WORKER_EXIT_CODES, checkWorkerStartup, restoreSuspected, startupLogLine } from '../src/index.ts';

/**
 * The worker's startup check, against a real database.
 *
 * Appendix G 22: old API with new worker and the reverse, across every expand and
 * contract phase, obey their schema ranges. A worker that cannot prove the schema is
 * one it understands exits non-zero rather than writing rows the other binary cannot
 * read.
 */
describe('worker startup', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is ready on a database inside its declared range', async () => {
    const report = await checkWorkerStartup({ session: database.session });
    expect(report).toEqual({
      component: 'worker',
      outcome: 'ready',
      declaredRange: { minimum: 1, maximum: 3 },
      databaseVersion: 3,
      systemGeneration: 1,
      reason: null,
      exitCode: WORKER_EXIT_CODES.ok,
    });
  });

  it('exits non-zero on a database behind its declared range', async () => {
    const behind = await createTestDatabase({ throughVersion: 0 });
    try {
      const report = await checkWorkerStartup({ session: behind.session });
      expect(report.outcome).toBe('schema_out_of_range');
      expect(report.reason).toBe('database_behind_binary');
      expect(report.exitCode).toBe(WORKER_EXIT_CODES.schemaOutOfRange);
      expect(report.exitCode).not.toBe(0);
    } finally {
      await behind.drop();
    }
  });

  it('exits non-zero, and names nothing, when the database cannot answer', async () => {
    const broken = {
      query: async () => {
        await Promise.resolve();
        throw new Error('connection to server at "10.0.0.5", port 5432 failed');
      },
    };
    const report = await checkWorkerStartup({ session: broken });
    expect(report.outcome).toBe('database_unreachable');
    expect(report.exitCode).toBe(WORKER_EXIT_CODES.databaseUnreachable);
    expect(startupLogLine(report)).not.toContain('10.0.0.5');
  });

  it('notices a restore by the system generation, and still starts', async () => {
    const report = await checkWorkerStartup({ session: database.session });
    expect(restoreSuspected(report, 1)).toBe(false);
    // The operator expected generation 4; the restored database says 1.
    expect(restoreSuspected(report, 4)).toBe(true);
    // Restore holds are what stop sending and dialing, not a refusal to start.
    expect(report.outcome).toBe('ready');
    expect(restoreSuspected(report, undefined)).toBe(false);
  });

  it('logs one structured redacted line', async () => {
    const report = await checkWorkerStartup({ session: database.session });
    expect(JSON.parse(startupLogLine(report))).toEqual({
      component: 'worker',
      outcome: 'ready',
      schemaRange: '1-3',
      databaseVersion: 3,
      systemGeneration: 1,
      reason: null,
    });
  });
});
