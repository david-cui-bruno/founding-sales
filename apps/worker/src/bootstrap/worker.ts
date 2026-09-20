import type { SessionQueryable } from '@fss/domain/db';
import { collectJobMetrics, type HandlerRegistry, type MetricSink } from '@fss/domain/jobs';
import { collectMailMetrics } from '@fss/domain/mail';
import { checkWorkerStartup, restoreSuspected, type WorkerStartupReport } from '../index.ts';
import { runOnce } from '../runner/jobRunner.ts';
import { runSchedulerPass, type DueWorkSource } from '../scheduler/schedulerPass.ts';
import type { WorkerConfig } from './config.ts';
import { createLiveness, type Liveness } from './liveness.ts';
import { errorFields, type Logger } from './log.ts';
import { drain, startLoop, type Loop } from './loop.ts';

/**
 * The worker process (specification 13, 4.2, Appendix E).
 *
 * Three loops on three sets of connections, started together and stopped together:
 *
 * * **the scheduler timer** — one bounded pass a minute on a dedicated connection,
 *   under the advisory lock, inserting due work and no external action (13.1);
 * * **the runner slots** — one connection each, claiming and running jobs, concurrency
 *   one by default because nothing in version one needs more and a second slot is a
 *   second lease to reason about;
 * * **the metric publication** — the operational gauges once a minute through G5's
 *   sink, which is a validating no-op unless the process was given a real transport.
 *
 * Startup refuses a database outside the declared schema range, because an old worker
 * beside a new one under expand/migrate/contract must stop rather than write rows the
 * other cannot read (4.2). A restored database is *not* a refusal: restore holds are
 * what stop sending and dialing, so the worker runs and logs the event the
 * `RestoreGenerationMismatches` metric filter counts (Appendix E 1).
 *
 * Stopping drains. `SIGTERM` on Fargate is a promise of `stopTimeout` seconds, so the
 * loops finish the pass in flight — the job keeps the lease it already holds — and
 * only then do the connections close.
 */

export interface WorkerSessions {
  /** One backend, used by nothing else: the advisory lock is per connection. */
  readonly scheduler: SessionQueryable;
  /** One per runner slot. Two slots may not share a connection; a transaction is not shareable. */
  readonly runners: readonly SessionQueryable[];
  readonly metrics: SessionQueryable;
}

export interface WorkerProcessOptions {
  readonly config: WorkerConfig;
  readonly sessions: WorkerSessions;
  readonly registry: HandlerRegistry;
  readonly sources: readonly DueWorkSource[];
  readonly sink: MetricSink;
  readonly log: Logger;
  readonly liveness?: Liveness | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface WorkerStopReport {
  readonly reason: string;
  /** False when a loop was still running at the drain deadline. */
  readonly drained: boolean;
  readonly schedulerPasses: number;
  readonly runnerPasses: number;
  readonly metricPublications: number;
  readonly jobsCompleted: number;
  readonly jobsFailed: number;
}

export interface WorkerRuntime {
  readonly instanceKey: string;
  readonly startup: WorkerStartupReport;
  stop(reason: string): Promise<WorkerStopReport>;
}

/** Thrown when the process must not run at all. Carries the exit code for `main`. */
export class WorkerStartupRefusal extends Error {
  constructor(
    readonly report: WorkerStartupReport,
    readonly exitCode: number,
  ) {
    super(`the worker refused to start: ${report.outcome}`);
    this.name = 'WorkerStartupRefusal';
  }
}

export async function startWorker(options: WorkerProcessOptions): Promise<WorkerRuntime> {
  const { config, sessions, log } = options;

  if (sessions.runners.length !== config.concurrency) {
    throw new Error(
      `the worker was given ${String(sessions.runners.length)} runner connections for a concurrency of ${String(config.concurrency)}`,
    );
  }

  const startup = await checkWorkerStartup({
    session: sessions.scheduler,
    ...(config.expectedSystemGeneration === null ? {} : { expectedSystemGeneration: config.expectedSystemGeneration }),
  });
  if (startup.outcome !== 'ready') {
    log.log('error', 'worker_startup_refused', {
      outcome: startup.outcome,
      reason: startup.reason,
      schema_range: `${String(startup.declaredRange.minimum)}-${String(startup.declaredRange.maximum)}`,
      database_version: startup.databaseVersion,
    });
    throw new WorkerStartupRefusal(startup, startup.exitCode);
  }

  if (restoreSuspected(startup, config.expectedSystemGeneration ?? undefined)) {
    // The exact event name infra/modules/observability/main.tf turns into
    // RestoreGenerationMismatches, which 13.3 makes immediately critical.
    log.log('error', 'restore_generation_mismatch', {
      expected_generation: config.expectedSystemGeneration,
      observed_generation: startup.systemGeneration,
    });
  }

  const liveness =
    options.liveness ??
    createLiveness({
      path: config.livenessFilePath,
      failuresBeforeRemoval: config.livenessFailuresBeforeRemoval,
      instanceKey: config.instanceKey,
    });
  const now = options.now ?? ((): Date => new Date());
  // Alive as soon as the schema is proved, rather than after the first pass: the
  // container health check has a start period, not a grace for a file that is late.
  liveness.report('startup', true);

  let jobsCompleted = 0;
  let jobsFailed = 0;
  let metricPublications = 0;
  let deadJobWatermark = now().toISOString();

  const onError = (loop: string) => (error: unknown) => {
    liveness.report(loop, false);
    // `level: error` is what the ApiErrors/WorkerErrors metric filters count.
    log.log('error', 'worker_loop_failed', { loop, ...errorFields(error) });
  };

  const schedulerLoop = startLoop({
    name: 'scheduler',
    intervalMilliseconds: config.schedulerIntervalMilliseconds,
    onError: onError('scheduler'),
    run: async () => {
      const report = await runSchedulerPass(sessions.scheduler, {
        sources: options.sources,
        now: now().toISOString(),
        instanceKey: config.instanceKey,
        statementTimeoutMilliseconds: config.statementTimeoutMilliseconds,
        passTimeoutMilliseconds: config.passTimeoutMilliseconds,
      });
      liveness.report('scheduler', true);
      if (report.inserted > 0 || report.outcome !== 'ran') {
        log.log('info', 'scheduler_pass', {
          outcome: report.outcome,
          inserted: report.inserted,
          already_present: report.alreadyPresent,
        });
      }
      // Always idle: the pass is on a fixed cadence, whatever it found.
      return 'idle';
    },
  });

  /** One dead job per line, because the metric filter counts events, not values. */
  const reportDeadJobs = async (session: SessionQueryable): Promise<void> => {
    const { rows } = await session.query<{ kind: string; error_code: string | null; dead_at: string }>(
      `SELECT kind, error_code, dead_at::text AS dead_at
         FROM jobs
        WHERE state = 'dead' AND dead_at > $1::timestamptz
        ORDER BY dead_at
        LIMIT 100`,
      [deadJobWatermark],
    );
    for (const row of rows) {
      // `$.event = "job_dead"` with the `kind` dimension: observability/main.tf.
      log.log('error', 'job_dead', { kind: row.kind, error_code: row.error_code });
      if (row.dead_at > deadJobWatermark) deadJobWatermark = row.dead_at;
    }
  };

  const runnerLoops = sessions.runners.map((session, index) => {
    const owner = `${config.instanceKey}:${String(index)}`;
    const name = `runner-${String(index)}`;
    return startLoop({
      name,
      intervalMilliseconds: config.runnerIdleMilliseconds,
      onError: onError(name),
      run: async () => {
        const report = await runOnce(session, {
          registry: options.registry,
          owner,
          // One claim per pass per slot: the slot is the concurrency, so a slot that
          // claimed two jobs would run them one after the other while their leases run.
          limit: 1,
          instanceKey: config.instanceKey,
        });
        liveness.report(name, true);
        jobsCompleted += report.completed;
        jobsFailed += report.failed;
        if (report.failed > 0) await reportDeadJobs(session);
        return report.claimed > 0 ? 'busy' : 'idle';
      },
    });
  });

  const metricsLoop = startLoop({
    name: 'metrics',
    intervalMilliseconds: config.metricsIntervalMilliseconds,
    onError: onError('metrics'),
    run: async () => {
      // The job, heartbeat, canary and alert gauges, then the mail lane's two.
      // `GmailWatchHoursToExpiry` is published only when there is a connected
      // mailbox to publish it for: the alarm treats missing data as not breaching,
      // so a deployment with no mailbox and one with a healthy mailbox look the
      // same to it, which is right — neither is a watch about to lapse.
      const data = [...(await collectJobMetrics(sessions.metrics)), ...(await collectMailMetrics(sessions.metrics))];
      await options.sink.publish(data);
      metricPublications += 1;
      liveness.report('metrics', true);
      return 'idle';
    },
  });

  const loops: readonly Loop[] = [schedulerLoop, ...runnerLoops, metricsLoop];
  log.log('info', 'worker_started', {
    concurrency: config.concurrency,
    scheduler_interval_ms: config.schedulerIntervalMilliseconds,
    metrics_interval_ms: config.metricsIntervalMilliseconds,
    database_version: startup.databaseVersion,
    system_generation: startup.systemGeneration,
  });

  let stopped: Promise<WorkerStopReport> | null = null;

  return {
    instanceKey: config.instanceKey,
    startup,
    stop: async (reason: string): Promise<WorkerStopReport> => {
      // Idempotent: a second SIGTERM must not start a second drain.
      stopped ??= (async () => {
        log.log('info', 'worker_stopping', { reason });
        const drained = await drain(loops, config.drainTimeoutMilliseconds);
        liveness.remove();
        const report: WorkerStopReport = {
          reason,
          drained,
          schedulerPasses: schedulerLoop.passes,
          runnerPasses: runnerLoops.reduce((total, loop) => total + loop.passes, 0),
          metricPublications,
          jobsCompleted,
          jobsFailed,
        };
        log.log(drained ? 'info' : 'error', 'worker_stopped', {
          reason,
          drained,
          jobs_completed: report.jobsCompleted,
          jobs_failed: report.jobsFailed,
          scheduler_passes: report.schedulerPasses,
        });
        return report;
      })();
      return stopped;
    },
  };
}
