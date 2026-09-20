import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import type { SessionQueryable } from '@fss/domain/db';
import {
  HandlerRegistry,
  canaryHandler,
  enqueueJob,
  raiseCriticalAlert,
  recordingMetricSink,
  type JobHandler,
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
    FSS_SCHEMA_MIN: '2',
    FSS_SCHEMA_MAX: '2',
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
});
