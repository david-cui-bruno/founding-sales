import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { WORKER_SCHEMA_RANGE } from '@fss/domain/db/schemaRange.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { recordingMetricSink, type MetricDatum } from '@fss/domain/jobs/metrics.ts';
import { readWorkerConfig } from '../src/bootstrap/config.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';
import { startWorker } from '../src/bootstrap/worker.ts';
import type { DueWorkSource } from '../src/scheduler/schedulerPass.ts';
import { todayBuildJobHandler, todayBuildJobKey, todayBuildSource } from '../src/handlers/todayBuild.ts';

/**
 * `TodaySnapshotMissing` through the real worker, in production's shape: one
 * workspace, zero firms (specification 8.2, 13.3; lane g67).
 *
 * The domain tests decide the semantics case by case. This file proves the chain the
 * alarm depends on — the scheduler pass materializes the day's `today.build`, a runner
 * completes it, and the metric loop, reading the same clock the pass was handed, flips
 * from 1 to 0 — for a workspace whose build writes no `today_snapshots` row at all.
 * A gauge that counted rows would stay at 1 here forever.
 *
 * The worker is given a fixed clock. The two instants are 06:00 and 05:05 in New
 * York on 21 September 2026, so whichever the real time is, a collector that ignored
 * the worker's clock would fail one of the cases below.
 */

const AFTER_DEADLINE = '2026-09-21T10:00:00.000Z';
const BEFORE_DEADLINE = '2026-09-21T09:05:00.000Z';

describe('the worker publishes TodaySnapshotMissing from the job, not the rows', () => {
  let database: TestDatabase;
  let workspaceId = '';

  beforeAll(async () => {
    database = await createTestDatabase();
    const created = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name, business_time_zone) VALUES ('alpha', 'Alpha Test', 'America/New_York') RETURNING id",
    );
    workspaceId = created.rows[0]?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  /** Run a worker on a fixed clock until `done` holds for what it has published. */
  const runWorker = async (options: {
    readonly at: string;
    readonly sources: readonly DueWorkSource[];
    readonly registry: HandlerRegistry;
    readonly done: (published: readonly MetricDatum[]) => boolean;
  }): Promise<number[]> => {
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
        FSS_WORKER_LIVENESS_FILE: join(tmpdir(), `${database.name}-today-liveness`),
      }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [await database.appRuntimeSession()],
        metrics: await database.appRuntimeSession(),
      },
      registry: options.registry,
      sources: options.sources,
      sink,
      log: recordingLogger(),
      now: () => new Date(options.at),
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !options.done(sink.published)) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await worker.stop('test');
    return sink.published.filter(datum => datum.name === 'TodaySnapshotMissing').map(datum => datum.value);
  };

  const published = (data: readonly MetricDatum[], count: number): boolean =>
    data.filter(datum => datum.name === 'TodaySnapshotMissing').length >= count;

  it('reads 0 at 05:05 local with nothing built', async () => {
    const values = await runWorker({
      at: BEFORE_DEADLINE,
      sources: [],
      registry: new HandlerRegistry(),
      done: data => published(data, 3),
    });
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(new Set(values)).toEqual(new Set([0]));
  });

  it('reads 1 at 06:00 local while no build has run', async () => {
    const values = await runWorker({
      at: AFTER_DEADLINE,
      sources: [],
      registry: new HandlerRegistry(),
      done: data => published(data, 3),
    });
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(new Set(values)).toEqual(new Set([1]));
  });

  it('reads 0 once the scheduler has materialized the day’s build and a runner has completed it', async () => {
    const values = await runWorker({
      at: AFTER_DEADLINE,
      sources: [todayBuildSource()],
      registry: new HandlerRegistry().register(todayBuildJobHandler()),
      done: data => data.some(datum => datum.name === 'TodaySnapshotMissing' && datum.value === 0),
    });
    expect(values.at(-1)).toBe(0);

    const job = await database.session.query<{ state: string; idempotency_key: string }>(
      "SELECT state, idempotency_key FROM jobs WHERE workspace_id = $1 AND kind = 'today.build'",
      [workspaceId],
    );
    expect(job.rows).toEqual([{ state: 'done', idempotency_key: todayBuildJobKey('alpha', '2026-09-21') }]);
    // The build ran and, with no firm, wrote nothing: the case "rows exist" gets wrong.
    const snapshots = await database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM today_snapshots WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(snapshots.rows[0]?.count).toBe('0');
  });
});
