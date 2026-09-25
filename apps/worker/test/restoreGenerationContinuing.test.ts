import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { WORKER_SCHEMA_RANGE } from '@fss/domain/db';
import { HandlerRegistry, recordingMetricSink } from '@fss/domain/jobs';
import { readWorkerConfig } from '../src/bootstrap/config.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';
import { observeRestoreGeneration } from '../src/bootstrap/restoreGeneration.ts';
import { startWorker } from '../src/bootstrap/worker.ts';

/**
 * A restore-generation mismatch keeps its alarm in ALARM for as long as it lasts
 * (audit O16, lane g81).
 *
 * `restore_generation_mismatch` is the event `infra/modules/observability` turns into
 * `RestoreGenerationMismatches`, and 13.3 makes that immediately critical. Until this
 * lane the worker wrote it once, at startup; the alarm is one datapoint in the
 * evaluation window with missing data not breaching, so it read OK a few minutes later
 * while the database was still on the wrong generation. Now the metric loop writes it
 * on every pass while the pin and the database differ, and stops once they agree.
 *
 * ## The vacuous-pass trap, named
 *
 * Counting lines alone would pass against a worker that logged the event on every
 * pass whatever the database said. So the second half reconciles the generation — the
 * row Appendix E step 9 writes — and requires the lines to stop, with the metric loop
 * demonstrably still running (its publications keep growing) while they do.
 */

const continuing = (lines: readonly Record<string, unknown>[]): number =>
  lines.filter(line => line['event'] === 'restore_generation_mismatch' && line['continuing'] === true).length;

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('the restore-generation mismatch while it persists', () => {
  let database: TestDatabase;
  let adminUserId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const user = await database.session.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-o16', 'o16@example.test', 'Admin') RETURNING id",
    );
    adminUserId = user.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await database.drop();
  });

  it('says nothing when unpinned or matching, and names both numbers when not', async () => {
    const log = recordingLogger();
    expect((await observeRestoreGeneration(database.session, { expectedGeneration: null, log })).mismatch).toBe(false);
    expect((await observeRestoreGeneration(database.session, { expectedGeneration: 1, log })).mismatch).toBe(false);
    expect(log.lines).toEqual([]);

    const observed = await observeRestoreGeneration(database.session, { expectedGeneration: 7, log });
    expect(observed).toEqual({ expectedGeneration: 7, observedGeneration: 1, mismatch: true });
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatchObject({
      level: 'error',
      event: 'restore_generation_mismatch',
      expected_generation: 7,
      observed_generation: 1,
      continuing: true,
    });
  });

  it('logs the mismatch on every metric pass until the generation is reconciled', async () => {
    const log = recordingLogger();
    const sink = recordingMetricSink();
    const worker = await startWorker({
      config: readWorkerConfig({
        FSS_ROLE: 'worker',
        FSS_SCHEMA_MIN: String(WORKER_SCHEMA_RANGE.minimum),
        FSS_SCHEMA_MAX: String(WORKER_SCHEMA_RANGE.maximum),
        DATABASE_URL: 'postgresql://unused.invalid/fss',
        FSS_METRICS: 'off',
        FSS_SCHEDULER_INTERVAL_MS: '25',
        FSS_METRICS_INTERVAL_MS: '25',
        FSS_RUNNER_IDLE_MS: '10',
        FSS_WORKER_INSTANCE: 'worker-o16',
        FSS_EXPECTED_SYSTEM_GENERATION: '2',
        FSS_WORKER_LIVENESS_FILE: join(tmpdir(), `${database.name}-o16-liveness`),
      }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [await database.appRuntimeSession()],
        metrics: await database.appRuntimeSession(),
      },
      registry: new HandlerRegistry(),
      sources: [],
      sink,
      log,
    });
    try {
      // The database is on generation 1 and the pin says 2: the startup line, then one
      // per pass.
      await until(() => continuing(log.lines) >= 3, 'three passes to report the mismatch');
      expect(log.lines.some(line => line['event'] === 'restore_generation_mismatch' && line['continuing'] === undefined)).toBe(
        true,
      );

      // Appendix E step 9's row: the database is now on the pinned generation.
      await database.session.query(
        `INSERT INTO system_generations (generation, reason, established_at, established_by_user_id, notes)
         VALUES (2, 'restore_completed', now(), $1, 'o16 test')`,
        [adminUserId],
      );

      // Let a pass that began before the insert finish, then measure.
      const published = (): number => sink.published.filter(datum => datum.name === 'WorkerHeartbeat').length;
      const atInsert = published();
      await until(() => published() >= atInsert + 2, 'two metric passes after the reconcile');
      const settled = continuing(log.lines);
      const afterSettle = published();
      await until(() => published() >= afterSettle + 3, 'three more metric passes');
      expect(continuing(log.lines)).toBe(settled);
    } finally {
      await worker.stop('test');
    }
  });
});
