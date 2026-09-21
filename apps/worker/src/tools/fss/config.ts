import { ConfigError, databaseConnection } from '../../bootstrap/config.ts';
import { DEPLOYMENT_ENVIRONMENT_VARIABLES } from '../../bootstrap/deployment.ts';
import type { LogFields } from '../../bootstrap/log.ts';

/**
 * What the operations command line needs before it does anything (lane G12g).
 *
 * The tool runs in two places and must resolve its configuration identically in both:
 *
 *   * on a laptop or a CI runner, from `DATABASE_URL`;
 *   * as a command override of the worker image inside the VPC, where the database
 *     credential arrives as the Secrets Manager *value* in `DATABASE_SECRET_ARN`
 *     through the ECS `secrets` block.
 *
 * So `databaseConnection` is imported from the worker's own bootstrap rather than
 * reimplemented. There is no third way to reach a database in this repository, and a
 * tool with its own would be the way a migration gets applied to the wrong one.
 *
 * What it deliberately does **not** read is `FSS_SCHEMA_MIN`/`FSS_SCHEMA_MAX`. The
 * worker refuses to start unless the database's schema version is exactly the range it
 * declares; `fss migrate` is the command that makes that true, so requiring the range
 * to agree first would be a tool that cannot be used for the one thing it is for.
 */

export interface ToolConfig {
  /** Held, never logged. `describeToolConfig` is the only thing that leaves the process. */
  readonly database: { readonly connectionString: string };
  /** `DATABASE_URL` or the injected secret. A name, never a value. */
  readonly databaseSource: 'DATABASE_URL' | 'DATABASE_SECRET_ARN';
  readonly environmentName: string;
  readonly region: string | null;
  /** The object-locked suppression journal the replay reads. A bucket name. */
  readonly journalBucket: string | null;
}

export function readToolConfig(environment: Readonly<Record<string, string | undefined>>): ToolConfig {
  const database = databaseConnection(environment);
  const url = environment['DATABASE_URL']?.trim();
  const region = environment[DEPLOYMENT_ENVIRONMENT_VARIABLES.region]?.trim();
  const bucket = environment[DEPLOYMENT_ENVIRONMENT_VARIABLES.journalBucket]?.trim();
  return {
    database,
    databaseSource: url !== undefined && url.length > 0 ? 'DATABASE_URL' : 'DATABASE_SECRET_ARN',
    environmentName: environment[DEPLOYMENT_ENVIRONMENT_VARIABLES.environmentName]?.trim() ?? 'unset',
    region: region !== undefined && region.length > 0 ? region : null,
    journalBucket: bucket !== undefined && bucket.length > 0 ? bucket : null,
  };
}

/**
 * The `--selftest` line: every decision this process made and no value that could be a
 * credential. The same contract `describeWorkerConfig` and `describeDeployment` keep,
 * because this tool runs in the same log group.
 */
export function describeToolConfig(config: ToolConfig): LogFields {
  return {
    tool: 'fss',
    environment: config.environmentName,
    database_source: config.databaseSource,
    region: config.region,
    journal: config.journalBucket === null ? 'absent' : 'configured',
  };
}

export { ConfigError };
