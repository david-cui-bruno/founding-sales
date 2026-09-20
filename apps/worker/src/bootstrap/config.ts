import { WORKER_SCHEMA_RANGE } from '@fss/domain/db';
import type { LogFields } from './log.ts';

/**
 * The worker's environment contract with its task definition.
 *
 * `infra/modules/cluster/main.tf` sets `FSS_ROLE`, `FSS_SCHEMA_MIN`, `FSS_SCHEMA_MAX`,
 * `FSS_METRIC_NAMESPACE`, `FSS_NAME_PREFIX` and `AWS_REGION`, and injects the database
 * secret through the ECS `secrets` block, which puts the secret's *value* into
 * `DATABASE_SECRET_ARN`. Everything this process needs is read here, once, at startup,
 * and every refusal names the variable rather than what was in it.
 *
 * The schema range is read as well as declared. The image knows the range it accepts;
 * the task definition also states one. If they disagree, one of the two is a stale
 * deployment and the conservative option is to stop rather than pick a winner.
 */

export type ConfigErrorCode = 'MISSING' | 'INVALID' | 'SCHEMA_RANGE_DISAGREES';

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type MetricMode = 'on' | 'off' | 'auto';

export interface WorkerConfig {
  readonly role: 'worker';
  readonly instanceKey: string;
  readonly namePrefix: string | null;
  readonly schemaRange: { readonly minimum: number; readonly maximum: number };
  readonly concurrency: number;
  readonly schedulerIntervalMilliseconds: number;
  readonly metricsIntervalMilliseconds: number;
  readonly runnerIdleMilliseconds: number;
  readonly drainTimeoutMilliseconds: number;
  readonly statementTimeoutMilliseconds: number;
  readonly passTimeoutMilliseconds: number;
  readonly metrics: {
    readonly mode: MetricMode;
    readonly namespace: string;
    readonly region: string | null;
  };
  /** Appendix E step 1. Null when the operator has not pinned a generation. */
  readonly expectedSystemGeneration: number | null;
  readonly livenessFilePath: string;
  readonly livenessFailuresBeforeRemoval: number;
  /** Held, never logged. `describeWorkerConfig` is the only thing that leaves this process. */
  readonly database: { readonly connectionString: string };
}

/** The container health check in infra/modules/cluster stats exactly this path. */
export const DEFAULT_LIVENESS_FILE = '/tmp/fss-worker-heartbeat';

/** 13.1: "Once per minute, one bounded pass". */
export const DEFAULT_SCHEDULER_INTERVAL_MILLISECONDS = 60_000;
export const DEFAULT_METRICS_INTERVAL_MILLISECONDS = 60_000;
export const DEFAULT_RUNNER_IDLE_MILLISECONDS = 1_000;
/**
 * The ECS task definition gives the worker `stopTimeout = 120`. Draining has to finish
 * inside that or the task is killed mid-transaction, so the budget is deliberately
 * shorter than the container's.
 */
export const DEFAULT_DRAIN_TIMEOUT_MILLISECONDS = 100_000;

type Environment = Readonly<Record<string, string | undefined>>;

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new ConfigError('MISSING', `${name} is not set`);
  }
  return value.trim();
}

function positiveInteger(environment: Environment, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    // The value is never repeated: an environment variable is an operator's input and
    // may hold something that should not be in a log line.
    throw new ConfigError('INVALID', `${name} must be a positive integer`);
  }
  return value;
}

function metricMode(environment: Environment): MetricMode {
  const raw = (environment['FSS_METRICS'] ?? 'auto').trim().toLowerCase();
  if (raw === 'on' || raw === 'off' || raw === 'auto') return raw;
  throw new ConfigError('INVALID', 'FSS_METRICS must be on, off or auto');
}

/**
 * The connection string, from either `DATABASE_URL` (local and rehearsal) or the
 * Secrets Manager value the task definition injects into `DATABASE_SECRET_ARN`.
 *
 * An ARN arriving in that variable means the task definition used `environment`
 * instead of `secrets`, so the process would connect to nothing and report a
 * database-unreachable it could have refused at startup.
 */
function databaseConnection(environment: Environment): { readonly connectionString: string } {
  const url = environment['DATABASE_URL']?.trim();
  if (url !== undefined && url.length > 0) return { connectionString: url };

  const injected = environment['DATABASE_SECRET_ARN']?.trim();
  if (injected === undefined || injected.length === 0) {
    throw new ConfigError('MISSING', 'neither DATABASE_URL nor DATABASE_SECRET_ARN is set');
  }
  if (injected.startsWith('arn:')) {
    throw new ConfigError(
      'INVALID',
      'DATABASE_SECRET_ARN holds an ARN rather than the secret value; the task definition must inject it through the ECS secrets block',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(injected);
  } catch {
    throw new ConfigError('INVALID', 'DATABASE_SECRET_ARN is neither a Secrets Manager JSON value nor a URL');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigError('INVALID', 'DATABASE_SECRET_ARN does not hold a JSON object');
  }
  const secret = parsed as Record<string, unknown>;
  const field = (name: string): string => {
    const value = secret[name];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
    throw new ConfigError('INVALID', `DATABASE_SECRET_ARN does not carry ${name}`);
  };
  const user = encodeURIComponent(field('username'));
  const password = encodeURIComponent(field('password'));
  const host = field('host');
  const port = field('port');
  const database = field('dbname');
  return { connectionString: `postgresql://${user}:${password}@${host}:${port}/${database}` };
}

function instanceKey(environment: Environment): string {
  const explicit = environment['FSS_WORKER_INSTANCE']?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit.slice(0, 120);
  // On Fargate the task ARN is the only stable per-task identifier available without
  // a metadata call; the hostname is the task id, which is enough for a heartbeat key.
  const hostname = environment['HOSTNAME']?.trim();
  return (hostname !== undefined && hostname.length > 0 ? `worker-${hostname}` : 'worker').slice(0, 120);
}

export function readWorkerConfig(environment: Environment): WorkerConfig {
  const role = (environment['FSS_ROLE'] ?? 'worker').trim();
  if (role !== 'worker') throw new ConfigError('INVALID', 'FSS_ROLE is not worker');

  const declaredMinimum = Number(required(environment, 'FSS_SCHEMA_MIN'));
  const declaredMaximum = Number(required(environment, 'FSS_SCHEMA_MAX'));
  if (declaredMinimum !== WORKER_SCHEMA_RANGE.minimum || declaredMaximum !== WORKER_SCHEMA_RANGE.maximum) {
    throw new ConfigError(
      'SCHEMA_RANGE_DISAGREES',
      `FSS_SCHEMA_MIN and FSS_SCHEMA_MAX do not match the range this image accepts (${String(WORKER_SCHEMA_RANGE.minimum)}-${String(WORKER_SCHEMA_RANGE.maximum)})`,
    );
  }

  const expectedGeneration = environment['FSS_EXPECTED_SYSTEM_GENERATION']?.trim();
  if (expectedGeneration !== undefined && expectedGeneration.length > 0) {
    const value = Number(expectedGeneration);
    if (!Number.isInteger(value) || value < 1) {
      throw new ConfigError('INVALID', 'FSS_EXPECTED_SYSTEM_GENERATION must be a positive integer');
    }
  }

  const region = environment['AWS_REGION']?.trim();

  return {
    role: 'worker',
    instanceKey: instanceKey(environment),
    namePrefix: environment['FSS_NAME_PREFIX']?.trim() ?? null,
    schemaRange: { minimum: WORKER_SCHEMA_RANGE.minimum, maximum: WORKER_SCHEMA_RANGE.maximum },
    concurrency: positiveInteger(environment, 'FSS_WORKER_CONCURRENCY', 1),
    schedulerIntervalMilliseconds: positiveInteger(
      environment,
      'FSS_SCHEDULER_INTERVAL_MS',
      DEFAULT_SCHEDULER_INTERVAL_MILLISECONDS,
    ),
    metricsIntervalMilliseconds: positiveInteger(
      environment,
      'FSS_METRICS_INTERVAL_MS',
      DEFAULT_METRICS_INTERVAL_MILLISECONDS,
    ),
    runnerIdleMilliseconds: positiveInteger(environment, 'FSS_RUNNER_IDLE_MS', DEFAULT_RUNNER_IDLE_MILLISECONDS),
    drainTimeoutMilliseconds: positiveInteger(environment, 'FSS_DRAIN_TIMEOUT_MS', DEFAULT_DRAIN_TIMEOUT_MILLISECONDS),
    statementTimeoutMilliseconds: positiveInteger(environment, 'FSS_STATEMENT_TIMEOUT_MS', 5_000),
    passTimeoutMilliseconds: positiveInteger(environment, 'FSS_PASS_TIMEOUT_MS', 45_000),
    metrics: {
      mode: metricMode(environment),
      namespace: environment['FSS_METRIC_NAMESPACE']?.trim() ?? 'FSS',
      region: region !== undefined && region.length > 0 ? region : null,
    },
    expectedSystemGeneration:
      expectedGeneration !== undefined && expectedGeneration.length > 0 ? Number(expectedGeneration) : null,
    livenessFilePath: environment['FSS_WORKER_LIVENESS_FILE']?.trim() ?? DEFAULT_LIVENESS_FILE,
    livenessFailuresBeforeRemoval: positiveInteger(environment, 'FSS_LIVENESS_FAILURES', 3),
    database: databaseConnection(environment),
  };
}

/**
 * The startup line. It names every decision the process made and no value that could
 * be a credential: the connection string, the region's account, the secret — none of
 * them appear, because this object is what goes into CloudWatch Logs.
 */
export function describeWorkerConfig(config: WorkerConfig): LogFields {
  return {
    role: config.role,
    instance: config.instanceKey,
    schemaRange: `${String(config.schemaRange.minimum)}-${String(config.schemaRange.maximum)}`,
    concurrency: config.concurrency,
    schedulerIntervalMilliseconds: config.schedulerIntervalMilliseconds,
    metricsIntervalMilliseconds: config.metricsIntervalMilliseconds,
    runnerIdleMilliseconds: config.runnerIdleMilliseconds,
    drainTimeoutMilliseconds: config.drainTimeoutMilliseconds,
    metricsMode: config.metrics.mode,
    metricNamespace: config.metrics.namespace,
    metricRegion: config.metrics.region,
    expectedSystemGeneration: config.expectedSystemGeneration,
    livenessFilePath: config.livenessFilePath,
  };
}
