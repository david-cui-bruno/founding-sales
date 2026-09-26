import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { WORKER_SCHEMA_RANGE, checkSchemaRange } from '@fss/domain/db/schemaRange.ts';

/**
 * The worker skeleton (specification 4.2 and Appendix G 22).
 *
 * It connects, compares the database's applied schema version with the range this
 * binary declares, reports what it found, and exits non-zero on a mismatch. It runs no
 * job, claims no lease, and calls nothing outside the database.
 *
 * Exiting rather than degrading is the point. Under expand, migrate, contract an old
 * worker and a new one run side by side, and a worker that cannot prove the schema is
 * one it understands must stop instead of writing rows the other cannot read.
 */

export const WORKER_EXIT_CODES = Object.freeze({
  ok: 0,
  schemaOutOfRange: 10,
  databaseUnreachable: 11,
  /** The environment the task definition supplied could not be read (bootstrap/config.ts). */
  configurationInvalid: 12,
});

export interface WorkerStartupReport {
  readonly component: 'worker';
  readonly outcome: 'ready' | 'schema_out_of_range' | 'database_unreachable';
  readonly declaredRange: { readonly minimum: number; readonly maximum: number };
  readonly databaseVersion: number | null;
  readonly reason: 'database_behind_binary' | 'database_ahead_of_binary' | 'database_unreachable' | null;
  readonly exitCode: number;
}

export interface WorkerStartupOptions {
  readonly session: SessionQueryable;
}

const declaredRange = { minimum: WORKER_SCHEMA_RANGE.minimum, maximum: WORKER_SCHEMA_RANGE.maximum };

/** Check the database and decide whether this binary may run. Pure apart from the read. */
export async function checkWorkerStartup(options: WorkerStartupOptions): Promise<WorkerStartupReport> {
  let check;
  try {
    check = await checkSchemaRange(options.session, WORKER_SCHEMA_RANGE);
  } catch {
    return {
      component: 'worker',
      outcome: 'database_unreachable',
      declaredRange,
      databaseVersion: null,
      reason: 'database_unreachable',
      exitCode: WORKER_EXIT_CODES.databaseUnreachable,
    };
  }

  if (!check.accepted) {
    return {
      component: 'worker',
      outcome: 'schema_out_of_range',
      declaredRange,
      databaseVersion: check.version,
      reason: check.reason,
      exitCode: WORKER_EXIT_CODES.schemaOutOfRange,
    };
  }

  return {
    component: 'worker',
    outcome: 'ready',
    declaredRange,
    databaseVersion: check.version,
    reason: null,
    exitCode: WORKER_EXIT_CODES.ok,
  };
}

/** One structured, redacted line. No connection string, no host, no credential. */
export function startupLogLine(report: WorkerStartupReport): string {
  return JSON.stringify({
    component: report.component,
    outcome: report.outcome,
    schemaRange: `${String(report.declaredRange.minimum)}-${String(report.declaredRange.maximum)}`,
    databaseVersion: report.databaseVersion,
    reason: report.reason,
  });
}

/**
 * The process itself. `src/index.ts` stays the module surface — the startup check
 * above is imported by the scheduler and by tests — and the bootstrap below is what
 * the container runs (`docs/greenfield/processes.md`).
 */
export {
  ConfigError,
  DEFAULT_DRAIN_TIMEOUT_MILLISECONDS,
  DEFAULT_LIVENESS_FILE,
  DEFAULT_METRICS_INTERVAL_MILLISECONDS,
  DEFAULT_RUNNER_IDLE_MILLISECONDS,
  DEFAULT_SCHEDULER_INTERVAL_MILLISECONDS,
  describeWorkerConfig,
  readWorkerConfig,
  type MetricMode,
  type WorkerConfig,
} from './bootstrap/config.ts';
export { APPLICATION_RAISED_METRICS, type ApplicationRaisedMetric, type MetricRaiser } from './bootstrap/metricCoverage.ts';
export { createLiveness, noLiveness, type Liveness } from './bootstrap/liveness.ts';
export { suppressionFinalizeJobHandler } from './handlers/suppressionFinalize.ts';
export {
  TODAY_BUILD_LOCAL_MINUTE,
  todayBuildJobHandler,
  todayBuildJobKey,
  todayBuildSource,
  type TodayBuildHandlerOptions,
} from './handlers/todayBuild.ts';
export {
  sequenceActionJobHandler,
  sequenceActionSource,
  type SequenceActionHandlerOptions,
} from './handlers/sequenceAction.ts';
export { createLogger, errorFields, recordingLogger, type LogFields, type LogLevel, type Logger } from './bootstrap/log.ts';
export { drain, startLoop, type Loop, type PassOutcome } from './bootstrap/loop.ts';
export {
  WorkerStartupRefusal,
  startWorker,
  type WorkerProcessOptions,
  type WorkerRuntime,
  type WorkerSessions,
  type WorkerStopReport,
} from './bootstrap/worker.ts';
