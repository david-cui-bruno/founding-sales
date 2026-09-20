import type { SessionQueryable } from '@fss/domain/db';
import { WORKER_SCHEMA_RANGE, checkSchemaRange, readSystemGeneration } from '@fss/domain/db';

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
  readonly systemGeneration: number | null;
  readonly reason: 'database_behind_binary' | 'database_ahead_of_binary' | 'database_unreachable' | null;
  readonly exitCode: number;
}

export interface WorkerStartupOptions {
  readonly session: SessionQueryable;
  /**
   * The generation the operator expects (Appendix E step 1). When it is given and the
   * database reports another, the worker is looking at restored data: it still starts,
   * because restore holds are what stop sending and dialing, but the report says so.
   */
  readonly expectedSystemGeneration?: number | undefined;
}

const declaredRange = { minimum: WORKER_SCHEMA_RANGE.minimum, maximum: WORKER_SCHEMA_RANGE.maximum };

/** Check the database and decide whether this binary may run. Pure apart from the two reads. */
export async function checkWorkerStartup(options: WorkerStartupOptions): Promise<WorkerStartupReport> {
  let check;
  let generation: number | null;
  try {
    check = await checkSchemaRange(options.session, WORKER_SCHEMA_RANGE);
    generation = await readSystemGeneration(options.session);
  } catch {
    return {
      component: 'worker',
      outcome: 'database_unreachable',
      declaredRange,
      databaseVersion: null,
      systemGeneration: null,
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
      systemGeneration: generation,
      reason: check.reason,
      exitCode: WORKER_EXIT_CODES.schemaOutOfRange,
    };
  }

  return {
    component: 'worker',
    outcome: 'ready',
    declaredRange,
    databaseVersion: check.version,
    systemGeneration: generation,
    reason: null,
    exitCode: WORKER_EXIT_CODES.ok,
  };
}

/**
 * Whether a restore has left the database on a generation the operator did not expect.
 * The worker reports it; releasing the restore holds is an admin command (Appendix E 9).
 */
export function restoreSuspected(report: WorkerStartupReport, expectedSystemGeneration: number | undefined): boolean {
  if (expectedSystemGeneration === undefined) return false;
  return report.systemGeneration !== null && report.systemGeneration !== expectedSystemGeneration;
}

/** One structured, redacted line. No connection string, no host, no credential. */
export function startupLogLine(report: WorkerStartupReport): string {
  return JSON.stringify({
    component: report.component,
    outcome: report.outcome,
    schemaRange: `${String(report.declaredRange.minimum)}-${String(report.declaredRange.maximum)}`,
    databaseVersion: report.databaseVersion,
    systemGeneration: report.systemGeneration,
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
