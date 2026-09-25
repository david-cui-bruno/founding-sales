import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { WORKER_SCHEMA_RANGE, type SessionQueryable } from '@fss/domain/db';
import {
  HandlerRegistry,
  MetricError,
  canaryHandler,
  enqueueJob,
  raiseCriticalAlert,
  recordingMetricSink,
  type JobHandler,
  type MetricSink,
} from '@fss/domain/jobs';
import { canarySource } from '../src/scheduler/sources.ts';
import { readWorkerConfig, type WorkerConfig } from '../src/bootstrap/config.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';
import { WorkerStartupRefusal, startWorker } from '../src/bootstrap/worker.ts';

/**
 * The worker as it runs on Fargate.
 *
 * The three loops (scheduler timer, runner, metric publication) are started together
 * against a real PostgreSQL, and the tests below assert the things the container
 * contract depends on: the pass fires on its timer, the canary the pass materializes
 * is completed by the runner in the same process, SIGTERM lets the job in flight
 * finish, the liveness file the ECS health check stats appears and disappears, and a
 * database outside the declared range stops the process rather than degrading it.
 *
 * Two workspaces throughout, with colliding idempotency keys, and nothing crosses.
 */

const WORKSPACE_TIMEOUT_MILLISECONDS = 15_000;

interface SeededWorkspaces {
  readonly alpha: string;
  readonly beta: string;
}

async function seedTwoWorkspaces(session: SessionQueryable): Promise<SeededWorkspaces> {
  const rows = await Promise.all(
    ['alpha', 'beta'].map(async slug => {
      const created = await session.query<{ id: string }>(
        'INSERT INTO workspaces (slug, display_name) VALUES ($1, $2) RETURNING id',
        [slug, `Workspace ${slug}`],
      );
      return created.rows[0]?.id ?? '';
    }),
  );
  return { alpha: rows[0] ?? '', beta: rows[1] ?? '' };
}

/** Poll until `check` is true, or fail the test rather than hang the suite. */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WORKSPACE_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function testConfig(overrides: Readonly<Record<string, string>> = {}): WorkerConfig {
  return readWorkerConfig({
    FSS_ROLE: 'worker',
    // Derived, never written down twice: a lane that widens the range widens it here
    // too, and a task definition that disagrees with the binary is a startup refusal
    // (bootstrap/config.ts) rather than something a fixture can paper over.
    FSS_SCHEMA_MIN: String(WORKER_SCHEMA_RANGE.minimum),
    FSS_SCHEMA_MAX: String(WORKER_SCHEMA_RANGE.maximum),
    DATABASE_URL: 'postgresql://unused.invalid/fss',
    FSS_METRICS: 'off',
    FSS_SCHEDULER_INTERVAL_MS: '25',
    FSS_METRICS_INTERVAL_MS: '25',
    FSS_RUNNER_IDLE_MS: '10',
    FSS_WORKER_INSTANCE: 'worker-test',
    ...overrides,
  });
}

describe('the worker process', () => {
  let database: TestDatabase;
  let workspaces: SeededWorkspaces;
  let temporaryDirectory: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    workspaces = await seedTwoWorkspaces(database.session);
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'fss-worker-'));
  });

  afterAll(async () => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    await database.drop();
  });

  it('fires the scheduler pass on its timer and completes what the pass materialized', async () => {
    const livenessPath = join(temporaryDirectory, 'heartbeat-1');
    const registry = new HandlerRegistry().register(canaryHandler());
    const worker = await startWorker({
      config: testConfig({ FSS_WORKER_LIVENESS_FILE: livenessPath }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [await database.appRuntimeSession()],
        metrics: await database.appRuntimeSession(),
      },
      registry,
      sources: [canarySource()],
      sink: recordingMetricSink(),
      log: recordingLogger(),
    });

    try {
      // Both workspaces get their own canary row, and the runner in this same process
      // completes both: that is scheduler-to-worker liveness (13.3), proven end to end.
      await until(async () => {
        const { rows } = await database.session.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM canary_runs WHERE completed_at IS NOT NULL',
        );
        return Number(rows[0]?.count ?? '0') >= 2;
      }, 'both workspaces to complete a canary');

      const { rows } = await database.session.query<{ workspace_id: string }>(
        'SELECT DISTINCT workspace_id FROM canary_runs WHERE completed_at IS NOT NULL ORDER BY workspace_id',
      );
      expect(new Set(rows.map(row => row.workspace_id))).toEqual(new Set([workspaces.alpha, workspaces.beta]));

      // Both heartbeats exist, because both the alarms and the metric loop read them.
      const beats = await database.session.query<{ component: string }>(
        "SELECT DISTINCT component FROM heartbeats WHERE component IN ('scheduler', 'worker') ORDER BY component",
      );
      expect(beats.rows.map(row => row.component)).toEqual(['scheduler', 'worker']);

      // The health check in infra/modules/cluster stats this file.
      expect(existsSync(livenessPath)).toBe(true);
    } finally {
      const report = await worker.stop('test');
      expect(report.schedulerPasses).toBeGreaterThan(0);
      expect(report.jobsCompleted).toBeGreaterThan(0);
      expect(report.drained).toBe(true);
    }
  });

  it('drains the job it is running when it is asked to stop', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const slow: JobHandler = {
      kind: 'today.build',
      protection: 'business_uniqueness',
      maxAttempts: 4,
      leaseSeconds: 60,
      handle: async input => {
        started.push(input.job.id);
        await new Promise(resolve => setTimeout(resolve, 300));
        finished.push(input.job.id);
      },
    };
    const runner = await database.appRuntimeSession();
    await enqueueJob(database.session, {
      workspaceId: workspaces.alpha,
      kind: 'today.build',
      idempotencyKey: 'today:alpha:2026-09-20:v1',
      payload: {},
      maxAttempts: 4,
    });

    const worker = await startWorker({
      config: testConfig({ FSS_WORKER_LIVENESS_FILE: join(temporaryDirectory, 'heartbeat-2') }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [runner],
        metrics: await database.appRuntimeSession(),
      },
      registry: new HandlerRegistry().register(slow),
      sources: [],
      sink: recordingMetricSink(),
      log: recordingLogger(),
    });

    await until(async () => Promise.resolve(started.length === 1), 'the slow job to start');
    // SIGTERM arrives mid-job. The lease is still ours; the job finishes inside it.
    const report = await worker.stop('SIGTERM');
    expect(finished).toEqual(started);
    expect(report.reason).toBe('SIGTERM');
    expect(report.drained).toBe(true);
    expect(report.jobsCompleted).toBe(1);

    const { rows } = await database.session.query<{ state: string }>(
      "SELECT state FROM jobs WHERE kind = 'today.build' AND workspace_id = $1",
      [workspaces.alpha],
    );
    expect(rows[0]?.state).toBe('done');
  });

  it('publishes the operational metrics on its timer, and only names an alarm reads', async () => {
    const sink = recordingMetricSink();
    await raiseCriticalAlert(database.session, {
      workspaceId: workspaces.beta,
      alertKey: 'outbound_invariant_failure',
      detail: { scenario: 'test' },
    });

    const worker = await startWorker({
      config: testConfig({ FSS_WORKER_LIVENESS_FILE: join(temporaryDirectory, 'heartbeat-3') }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [await database.appRuntimeSession()],
        metrics: await database.appRuntimeSession(),
      },
      registry: new HandlerRegistry().register(canaryHandler()),
      sources: [canarySource()],
      sink,
      log: recordingLogger(),
    });

    try {
      await until(
        async () => Promise.resolve(sink.published.some(datum => datum.name === 'UnacknowledgedCriticalAlertAgeSeconds')),
        'the unacknowledged critical alert age to be published',
      );
      const names = new Set(sink.published.map(datum => datum.name));
      expect(names.has('WorkerHeartbeat')).toBe(true);
      expect(names.has('SchedulerHeartbeat')).toBe(true);
    } finally {
      const report = await worker.stop('test');
      expect(report.metricPublications).toBeGreaterThan(0);
    }
  });

  it('refuses to start against a database outside the declared schema range', async () => {
    const behind = await createTestDatabase({ throughVersion: 0 });
    try {
      let thrown: unknown = null;
      try {
        await startWorker({
          config: testConfig({ FSS_WORKER_LIVENESS_FILE: join(temporaryDirectory, 'heartbeat-4') }),
          sessions: { scheduler: behind.session, runners: [behind.session], metrics: behind.session },
          registry: new HandlerRegistry(),
          sources: [],
          sink: recordingMetricSink(),
          log: recordingLogger(),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WorkerStartupRefusal);
      expect((thrown as WorkerStartupRefusal).exitCode).toBe(10);
      expect((thrown as WorkerStartupRefusal).report.reason).toBe('database_behind_binary');
    } finally {
      await behind.drop();
    }
  });

  it('refuses a runner-session count that does not match the configured concurrency', async () => {
    await expect(
      startWorker({
        config: testConfig({ FSS_WORKER_CONCURRENCY: '3' }),
        sessions: {
          scheduler: await database.appRuntimeSession(),
          runners: [await database.appRuntimeSession()],
          metrics: await database.appRuntimeSession(),
        },
        registry: new HandlerRegistry(),
        sources: [],
        sink: recordingMetricSink(),
        log: recordingLogger(),
      }),
    ).rejects.toThrow(/concurrency/);
  });

  it('reports a restore by logging the event the metric filter counts, and still runs', async () => {
    const log = recordingLogger();
    const livenessPath = join(temporaryDirectory, 'heartbeat-5');
    const worker = await startWorker({
      config: testConfig({ FSS_EXPECTED_SYSTEM_GENERATION: '9', FSS_WORKER_LIVENESS_FILE: livenessPath }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [await database.appRuntimeSession()],
        metrics: await database.appRuntimeSession(),
      },
      registry: new HandlerRegistry(),
      sources: [],
      sink: recordingMetricSink(),
      log,
    });
    try {
      // infra/modules/observability/main.tf turns this exact event name into the
      // RestoreGenerationMismatches metric, which is immediately critical (13.3).
      const events = log.lines.map(line => line['event']);
      expect(events).toContain('restore_generation_mismatch');
      const mismatch = log.lines.find(line => line['event'] === 'restore_generation_mismatch');
      expect(mismatch?.['level']).toBe('error');
      // Restore holds stop sending and dialing; the worker still runs (Appendix E).
      expect(existsSync(livenessPath)).toBe(true);
    } finally {
      await worker.stop('test');
    }
  });

  it('removes the liveness file once the database stops answering', async () => {
    const livenessPath = join(temporaryDirectory, 'heartbeat-6');
    const failing: SessionQueryable = {
      query: async () => {
        await Promise.resolve();
        throw new Error('connection to server at "10.0.0.5", port 5432 failed');
      },
    };
    const worker = await startWorker({
      config: testConfig({ FSS_WORKER_LIVENESS_FILE: livenessPath, FSS_LIVENESS_FAILURES: '2' }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [failing],
        metrics: await database.appRuntimeSession(),
      },
      registry: new HandlerRegistry().register(canaryHandler()),
      sources: [],
      sink: recordingMetricSink(),
      log: recordingLogger(),
    });
    try {
      await until(async () => Promise.resolve(!existsSync(livenessPath)), 'the liveness file to be removed');
    } finally {
      await worker.stop('test');
    }
  });

  it('keeps the liveness file while CloudWatch rejects every publication (24 September 2026)', async () => {
    // What production saw from 18:11Z: every PutMetricData refused. The file used to
    // be removed after three and ECS replaced a worker that was otherwise healthy.
    const livenessPath = join(temporaryDirectory, 'heartbeat-7');
    let attempts = 0;
    const refusing: MetricSink = {
      publish: async () => {
        attempts += 1;
        await Promise.resolve();
        const error = new Error('The parameter MetricData.member.6.Unit must be a value in the set');
        error.name = 'InvalidParameterValueException';
        throw error;
      },
    };
    const log = recordingLogger();
    const worker = await startWorker({
      config: testConfig({ FSS_WORKER_LIVENESS_FILE: livenessPath, FSS_LIVENESS_FAILURES: '1' }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [await database.appRuntimeSession()],
        metrics: await database.appRuntimeSession(),
      },
      registry: new HandlerRegistry().register(canaryHandler()),
      sources: [],
      sink: refusing,
      log,
    });
    try {
      await until(async () => Promise.resolve(attempts >= 5), 'five refused publications');
      expect(existsSync(livenessPath), 'a refused publication removed the liveness file').toBe(true);
      const failures = log.lines.filter(line => line['event'] === 'worker_loop_failed' && line['loop'] === 'metrics');
      expect(failures.length).toBeGreaterThanOrEqual(5);
      expect(failures[0]).toMatchObject({ level: 'error', error_name: 'InvalidParameterValueException' });
    } finally {
      await worker.stop('test');
    }
  });

  it('logs each refused metric by name and counts the publication of the rest', async () => {
    const livenessPath = join(temporaryDirectory, 'heartbeat-8');
    const partial: MetricSink = {
      publish: async () => {
        await Promise.resolve();
        throw new MetricError('METRIC_REJECTED', 'not published: GmailWatchHoursToExpiry', [
          {
            name: 'GmailWatchHoursToExpiry',
            unit: 'Hours',
            errorName: 'METRIC_UNIT_INVALID',
            errorMessage: 'GmailWatchHoursToExpiry was given the unit Hours, which CloudWatch does not accept',
          },
        ]);
      },
    };
    const log = recordingLogger();
    const worker = await startWorker({
      config: testConfig({ FSS_WORKER_LIVENESS_FILE: livenessPath, FSS_LIVENESS_FAILURES: '1' }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [await database.appRuntimeSession()],
        metrics: await database.appRuntimeSession(),
      },
      registry: new HandlerRegistry().register(canaryHandler()),
      sources: [],
      sink: partial,
      log,
    });
    let report;
    try {
      await until(
        async () => Promise.resolve(log.lines.filter(line => line['event'] === 'metric_rejected').length >= 2),
        'two metric_rejected lines',
      );
      expect(existsSync(livenessPath)).toBe(true);
      expect(log.lines.find(line => line['event'] === 'metric_rejected')).toMatchObject({
        level: 'error',
        metric: 'GmailWatchHoursToExpiry',
        unit: 'Hours',
        error_name: 'METRIC_UNIT_INVALID',
      });
      expect(log.lines.some(line => line['event'] === 'worker_loop_failed' && line['loop'] === 'metrics')).toBe(false);
    } finally {
      report = await worker.stop('test');
    }
    expect(report.metricPublications).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Lane g56: a worker started against a database on a generation other than the one
 * the operator pinned opens the restore holds before any loop runs.
 *
 * Until this lane it logged the mismatch and held nothing, so a restored database was
 * worked from as soon as the worker reached it, and the drill's step 1 found no restore
 * hold (rehearsal run 36062337914, 24 September 2026).
 *
 * ## The vacuous-pass trap, named
 *
 * "The worker logged the mismatch" was already true and held nothing, so the log line
 * is not the assertion: the rows are, one per workspace, read back through the owner's
 * session after the worker opened them as `app_runtime`. And "opens holds when pinned
 * ahead" is only half of it: the same worker unpinned, or pinned to the database's own
 * generation, must open none, or every start would hold production.
 */
describe('the worker opens the restore holds when the database is not on the pinned generation', () => {
  let database: TestDatabase;
  let workspaces: SeededWorkspaces;
  let temporaryDirectory: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    workspaces = await seedTwoWorkspaces(database.session);
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'fss-worker-g56-'));
  });

  afterAll(async () => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    await database.drop();
  });

  async function openRestoreHolds(): Promise<readonly { workspace_id: string; source_event_id: string | null }[]> {
    const { rows } = await database.session.query<{ workspace_id: string; source_event_id: string | null }>(
      `SELECT workspace_id, source_event_id FROM active_holds
        WHERE reason_code = 'restore_in_progress' AND released_at IS NULL
        ORDER BY workspace_id`,
    );
    return rows;
  }

  async function startAndStop(
    environment: Readonly<Record<string, string>>,
    name: string,
  ): Promise<ReturnType<typeof recordingLogger>> {
    const log = recordingLogger();
    const livenessPath = join(temporaryDirectory, name);
    const worker = await startWorker({
      config: testConfig({ ...environment, FSS_WORKER_LIVENESS_FILE: livenessPath }),
      sessions: {
        scheduler: await database.appRuntimeSession(),
        runners: [await database.appRuntimeSession()],
        metrics: await database.appRuntimeSession(),
      },
      registry: new HandlerRegistry(),
      sources: [],
      sink: recordingMetricSink(),
      log,
    });
    try {
      // The worker still runs: the holds are what stop sending and dialing.
      expect(existsSync(livenessPath)).toBe(true);
    } finally {
      await worker.stop('test');
    }
    return log;
  }

  it('does nothing when unpinned', async () => {
    const log = await startAndStop({}, 'unpinned');
    expect(log.lines.map(line => line['event'])).not.toContain('restore_generation_mismatch');
    expect(await openRestoreHolds()).toHaveLength(0);
  });

  it('does nothing when the pin is the database’s own generation', async () => {
    const log = await startAndStop({ FSS_EXPECTED_SYSTEM_GENERATION: '1' }, 'equal');
    expect(log.lines.map(line => line['event'])).not.toContain('restore_generation_mismatch');
    expect(await openRestoreHolds()).toHaveLength(0);
  });

  it('opens one restore hold per workspace when pinned ahead, and logs the line the alarm counts', async () => {
    const log = await startAndStop({ FSS_EXPECTED_SYSTEM_GENERATION: '2' }, 'ahead');
    const rows = await openRestoreHolds();
    expect(rows.map(row => row.workspace_id).sort()).toEqual([workspaces.alpha, workspaces.beta].sort());
    expect(rows.every(row => row.source_event_id === 'worker:1->2')).toBe(true);

    // One startup line, which opened the holds. Since lane g81 (audit O16) the metric
    // loop repeats the event on each pass while the mismatch lasts, marked
    // `continuing`; `restoreGenerationContinuing.test.ts` holds that half.
    const mismatch = log.lines.filter(
      line => line['event'] === 'restore_generation_mismatch' && line['continuing'] === undefined,
    );
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toMatchObject({
      level: 'error',
      expected_generation: 2,
      observed_generation: 1,
      restore_holds_opened: 2,
      restore_holds_already_open: 0,
    });
    // Held before the loops: the mismatch line precedes worker_started.
    const events = log.lines.map(line => line['event']);
    expect(events.indexOf('restore_generation_mismatch')).toBeLessThan(events.indexOf('worker_started'));
  });

  it('a restart during the protocol opens nothing new and still raises the alarm', async () => {
    const log = await startAndStop({ FSS_EXPECTED_SYSTEM_GENERATION: '2' }, 'restart');
    expect(await openRestoreHolds()).toHaveLength(2);
    expect(log.lines.find(line => line['event'] === 'restore_generation_mismatch')).toMatchObject({
      restore_holds_opened: 0,
      restore_holds_already_open: 2,
    });
  });
});
