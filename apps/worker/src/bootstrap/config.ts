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
 *
 * The metric namespace is the same kind of fact (g42, lane g55). `infra/modules/stack`
 * derives `FSS/<name prefix>` once and the task definition carries it in
 * `FSS_METRIC_NAMESPACE` beside `FSS_NAME_PREFIX`. There is no default any more: the old
 * one was the bare `FSS`, which every environment in the account shared, so a rehearsal
 * worker fed production's alarms and the rehearsal smoke read production's canary age.
 * A worker that will publish refuses to start without a namespace, and refuses one that
 * is not `FSS/` followed by its own prefix.
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
    /**
     * `FSS/<name prefix>`. Null only when nothing will be published (metrics off, or no
     * region); a worker that would publish without one is refused at startup.
     */
    readonly namespace: string | null;
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

/** Every FSS namespace is this followed by the environment's name prefix. */
export const METRIC_NAMESPACE_ROOT = 'FSS';

/**
 * The CloudWatch namespace, `FSS/<name prefix>` (g42, lane g55).
 *
 * Required whenever the worker would publish: a deployed task always has a region, so
 * a task definition that lost `FSS_METRIC_NAMESPACE` is a worker that refuses to start,
 * not one that falls back to a namespace another environment is alarming on. When
 * nothing is published — metrics off, or no region, which is a laptop or a test — the
 * namespace is not needed and may be absent.
 *
 * When `FSS_NAME_PREFIX` is present (it always is in a task definition) the namespace
 * must be exactly `FSS/<that prefix>`: two values the task definition derives from one
 * prefix disagreeing means the definition was edited by hand, and the conservative
 * answer is the same as for a disagreeing schema range. Without a prefix the bare `FSS`
 * is still refused, because it is the one namespace that is certainly shared.
 */
function metricNamespace(environment: Environment, publishes: boolean, namePrefix: string | null): string | null {
  const raw = environment['FSS_METRIC_NAMESPACE']?.trim();
  if (raw === undefined || raw.length === 0) {
    if (publishes) throw new ConfigError('MISSING', 'FSS_METRIC_NAMESPACE is not set');
    return null;
  }
  if (namePrefix !== null) {
    if (raw !== `${METRIC_NAMESPACE_ROOT}/${namePrefix}`) {
      throw new ConfigError('INVALID', 'FSS_METRIC_NAMESPACE must be FSS/ followed by FSS_NAME_PREFIX');
    }
    return raw;
  }
  if (!raw.startsWith(`${METRIC_NAMESPACE_ROOT}/`) || raw.length === METRIC_NAMESPACE_ROOT.length + 1) {
    throw new ConfigError(
      'INVALID',
      'FSS_METRIC_NAMESPACE must be FSS/<name prefix>; the bare FSS namespace is shared by every environment in the account',
    );
  }
  return raw;
}

/**
 * The connection string, from either `DATABASE_URL` (local and rehearsal) or the
 * Secrets Manager value the task definition injects into `DATABASE_SECRET_ARN`.
 *
 * An ARN arriving in that variable means the task definition used `environment`
 * instead of `secrets`, so the process would connect to nothing and report a
 * database-unreachable it could have refused at startup.
 *
 * Exported because the operations command line (`src/tools/fss.ts`) has to resolve the
 * connection the same way and there must not be a second way: the tool runs from a
 * `DATABASE_URL` on a laptop and as a command override of this image in the VPC, and
 * in the second case the only thing that carries the credential is the ECS `secrets`
 * block this function already understands.
 */
export function databaseConnection(environment: Environment): { readonly connectionString: string } {
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
  const metricRegion = region !== undefined && region.length > 0 ? region : null;
  const prefix = environment['FSS_NAME_PREFIX']?.trim();
  const namePrefix = prefix !== undefined && prefix.length > 0 ? prefix : null;
  const mode = metricMode(environment);

  return {
    role: 'worker',
    instanceKey: instanceKey(environment),
    namePrefix,
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
      mode,
      // `createSink` publishes exactly when the mode is not off and a region is known,
      // so that is when a namespace is required.
      namespace: metricNamespace(environment, mode !== 'off' && metricRegion !== null, namePrefix),
      region: metricRegion,
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
