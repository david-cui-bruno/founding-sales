import { ConfigError, databaseConnection } from '../../bootstrap/config.ts';
import { DEPLOYMENT_ENVIRONMENT_VARIABLES } from '../../bootstrap/deployment.ts';
import type { LogFields } from '../../bootstrap/log.ts';

/**
 * What the operations command line needs before it does anything (lane G12g).
 *
 * The tool runs in two places and must resolve its configuration identically in both:
 *
 *   * on a laptop or a CI runner, from `DATABASE_URL`;
 *   * as a one-off ECS task in the VPC — David's decision of 21 September — where the
 *     database credential arrives as the Secrets Manager *value* in
 *     `DATABASE_SECRET_ARN` through the ECS `secrets` block.
 *
 * So `databaseConnection` is imported from the worker's own bootstrap rather than
 * reimplemented. There is no third way to reach a database in this repository, and a
 * tool with its own would be the way a migration gets applied to the wrong one.
 *
 * ## Two connections, not one
 *
 * `fss migrate` does **not** use the runtime connection. The runtime credential is
 * `app_runtime`'s and must stay that: a tool that applied DDL with it would either
 * fail or, worse, succeed because somebody had granted the application more than it
 * needs. The migration credential is its own secret —
 * `fss-<env>/database-migration-user`, injected as a value into
 * `MIGRATION_DATABASE_SECRET` — or `FSS_MIGRATION_DATABASE_URL` on a laptop. When
 * neither is present, `fss migrate` refuses; it never falls back to `DATABASE_URL`.
 *
 * ## The endpoint arrives in the environment
 *
 * `FSS_DATABASE_HOST` is Terraform's `active_database_host`: the managed instance's
 * address, or a point-in-time copy's while the restore runbook
 * (`docs/greenfield/runbooks/restore.md`) has pointed every task at it. It overrides the
 * host of a connection assembled from a secret value — the credential is still the
 * secret's, the endpoint moved — for the migration credential as well as the runtime one.
 * A connection given as a whole URL already names a host, and a `FSS_DATABASE_HOST` that
 * disagrees with it is refused rather than silently preferred — two sources naming two
 * hosts is not a choice a tool may make when one of them might be production.
 *
 * What it deliberately does **not** read is `FSS_SCHEMA_MIN`/`FSS_SCHEMA_MAX`. The
 * worker refuses to start unless the database's schema version is exactly the range it
 * declares; `fss migrate` is the command that makes that true, so requiring the range
 * to agree first would be a tool that cannot be used for the one thing it is for.
 */

/** The environment names this tool reads that are its own. */
export const TOOL_ENVIRONMENT_VARIABLES = Object.freeze({
  /** The runtime connection, for every command except `migrate`. */
  databaseUrl: 'DATABASE_URL',
  databaseSecret: 'DATABASE_SECRET_ARN',
  /** The migration user's connection. Its own secret, never the runtime one. */
  migrationDatabaseUrl: 'FSS_MIGRATION_DATABASE_URL',
  migrationDatabaseSecret: 'MIGRATION_DATABASE_SECRET',
  /** `active_database_host`: the instance every task connects to. */
  databaseHost: 'FSS_DATABASE_HOST',
} as const);

const V = TOOL_ENVIRONMENT_VARIABLES;

export type ConnectionSource = 'url' | 'secret';

export interface ToolConnection {
  /** Held, never logged. `describeToolConfig` is the only thing that leaves the process. */
  readonly connectionString: string;
  readonly source: ConnectionSource;
  /** `environment` when `FSS_DATABASE_HOST` replaced the secret's host. */
  readonly hostSource: 'secret' | 'url' | 'environment';
}

export interface ToolConfig {
  /**
   * The application's connection. Null only when `readToolConfig` was asked for an
   * optional runtime connection and none is configured: the migration task definition
   * carries the migration credential and nothing the application connects with, so
   * `fss migrate` is the one command that runs without it.
   */
  readonly database: ToolConnection | null;
  /** Null when no migration credential is configured; `fss migrate` then refuses. */
  readonly migrationDatabase: ToolConnection | null;
  readonly environmentName: string;
  readonly region: string | null;
  /** The object-locked suppression journal the replay reads. A bucket name. */
  readonly journalBucket: string | null;
  /** What the operator declared about dependencies, unread and unresolved. */
  readonly dependencies: string | null;
}

type Environment = Readonly<Record<string, string | undefined>>;

const trimmed = (environment: Environment, name: string): string | undefined => {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

/**
 * Apply `FSS_DATABASE_HOST` to a connection, or refuse.
 *
 * A URL's host wins and a disagreement is a refusal; a secret's host is replaced,
 * because that is what `active_database_host` is for.
 */
export function applyHostOverride(
  connectionString: string,
  source: ConnectionSource,
  host: string | undefined,
): ToolConnection {
  if (host === undefined) {
    return { connectionString, source, hostSource: source === 'url' ? 'url' : 'secret' };
  }
  const url = new URL(connectionString);
  if (source === 'url') {
    if (url.hostname === host) return { connectionString, source, hostSource: 'url' };
    throw new ConfigError(
      'INVALID',
      `${V.databaseHost} names a different host from the one in the connection URL; one of the two is wrong and this tool will not pick`,
    );
  }
  url.hostname = host;
  return { connectionString: url.toString(), source, hostSource: 'environment' };
}

function runtimeConnection(environment: Environment): ToolConnection {
  const { connectionString } = databaseConnection(environment);
  const source: ConnectionSource = trimmed(environment, V.databaseUrl) === undefined ? 'secret' : 'url';
  return applyHostOverride(connectionString, source, trimmed(environment, V.databaseHost));
}

/**
 * The runtime connection when one is configured, null when neither variable is set.
 * A variable that is set but wrong (an ARN instead of a value, a secret missing a
 * field, a host that disagrees) is still a refusal: only the *absence* is tolerated,
 * and only for the caller that asked.
 */
function optionalRuntimeConnection(environment: Environment): ToolConnection | null {
  if (trimmed(environment, V.databaseUrl) === undefined && trimmed(environment, V.databaseSecret) === undefined) {
    return null;
  }
  return runtimeConnection(environment);
}

/**
 * The migration user's connection, or null.
 *
 * `databaseConnection` parses the Secrets Manager value shape, so the migration secret
 * is read by handing it a synthetic environment with the same field names — one parser
 * for both credentials, rather than a second one to drift.
 */
function migrationConnection(environment: Environment): ToolConnection | null {
  const url = trimmed(environment, V.migrationDatabaseUrl);
  if (url !== undefined) return applyHostOverride(url, 'url', trimmed(environment, V.databaseHost));
  const secret = trimmed(environment, V.migrationDatabaseSecret);
  if (secret === undefined) return null;
  const { connectionString } = databaseConnection({ DATABASE_SECRET_ARN: secret });
  return applyHostOverride(connectionString, 'secret', trimmed(environment, V.databaseHost));
}

export interface ReadToolConfigOptions {
  /**
   * `required` (the default) refuses when no runtime connection is configured, as every
   * command but `migrate` needs one. `optional` leaves `database` null instead; `fss
   * migrate` passes it, because the migration task definition deliberately injects no
   * `DATABASE_SECRET_ARN` (infra/modules/cluster, `migration_task_secrets`).
   */
  readonly runtimeConnection?: 'required' | 'optional';
}

export function readToolConfig(environment: Environment, options: ReadToolConfigOptions = {}): ToolConfig {
  const region = trimmed(environment, DEPLOYMENT_ENVIRONMENT_VARIABLES.region);
  const bucket = trimmed(environment, DEPLOYMENT_ENVIRONMENT_VARIABLES.journalBucket);
  return {
    database:
      options.runtimeConnection === 'optional' ? optionalRuntimeConnection(environment) : runtimeConnection(environment),
    migrationDatabase: migrationConnection(environment),
    environmentName: trimmed(environment, DEPLOYMENT_ENVIRONMENT_VARIABLES.environmentName) ?? 'unset',
    region: region ?? null,
    journalBucket: bucket ?? null,
    dependencies: trimmed(environment, DEPLOYMENT_ENVIRONMENT_VARIABLES.dependencies)?.toLowerCase() ?? null,
  };
}

/**
 * The `--selftest` and `verify` line: every decision this process made and no value
 * that could be a credential. The same contract `describeWorkerConfig` and
 * `describeDeployment` keep, because this tool runs in the same log group.
 */
export function describeToolConfig(config: ToolConfig): LogFields {
  return {
    tool: 'fss',
    environment: config.environmentName,
    database_source: config.database === null ? 'absent' : config.database.source,
    database_host_source: config.database === null ? 'absent' : config.database.hostSource,
    // `migration_from`, not `migration_credential`: `log.ts` redacts any field whose
    // *name* looks like a credential, and this one is a source, not a value.
    migration_from: config.migrationDatabase === null ? 'absent' : config.migrationDatabase.source,
    region: config.region,
    journal: config.journalBucket === null ? 'absent' : 'configured',
    dependencies: config.dependencies,
  };
}

export { ConfigError };
