import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { CURRENT_SCHEMA_VERSION, WORKER_SCHEMA_RANGE } from '@fss/domain/db/schemaRange.ts';
import { WORKER_EXIT_CODES, checkWorkerStartup, startupLogLine } from '../src/index.ts';

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
      // From the constants rather than repeated here, so widening the range for a
      // new migration is one edit in `schemaRange.ts` and not three in tests.
      declaredRange: { minimum: WORKER_SCHEMA_RANGE.minimum, maximum: WORKER_SCHEMA_RANGE.maximum },
      databaseVersion: CURRENT_SCHEMA_VERSION,
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

  it('logs one structured redacted line', async () => {
    const report = await checkWorkerStartup({ session: database.session });
    expect(JSON.parse(startupLogLine(report))).toEqual({
      component: 'worker',
      outcome: 'ready',
      schemaRange: `${String(WORKER_SCHEMA_RANGE.minimum)}-${String(WORKER_SCHEMA_RANGE.maximum)}`,
      databaseVersion: CURRENT_SCHEMA_VERSION,
      reason: null,
    });
  });
});
