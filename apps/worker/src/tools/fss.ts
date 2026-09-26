import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db';
import { ConfigError } from '../bootstrap/config.ts';
import { DeploymentConfigError, readWorkerDeployment } from '../bootstrap/deployment.ts';
import { composeHandlers } from '../bootstrap/main.ts';
import { createLogger, errorFields, type Logger } from '../bootstrap/log.ts';
import {
  holdsListCommand,
  mailboxReconcileSentCommand,
  releaseRecordPutCommand,
  releaseRecordShowCommand,
  suppressionJournalReplayCommand,
  type AdminInvocation,
  type AdminOutcome,
} from './fss/admin.ts';
import {
  TOOL_ENVIRONMENT_VARIABLES,
  describeToolConfig,
  readToolConfig,
  type ToolConfig,
} from './fss/config.ts';
import { loadS3JournalSource } from './fss/journalSource.ts';
import { readSchemaVersionReport, runMigrate } from './fss/migrate.ts';
import { schemaPreflight0019Command } from './fss/schemaPreflight0019.ts';
import { runVerify } from './fss/verify.ts';
import { bootstrapWorkspace } from './fss/bootstrapWorkspace.ts';
import { RUNTIME_SECRET_VARIABLE, ensureRuntimeDatabaseUser } from './fss/databaseUsers.ts';
import {
  COMMAND_DEPENDENCIES,
  describeCommands,
  parseFssCommand,
  type ParsedFssCommand,
} from './fss/commands.ts';

/**
 * `fss`: the operations command line (lane G12g).
 *
 *   node apps/worker/src/tools/fss.ts migrate
 *   node apps/worker/src/tools/fss.ts admin holds list
 *
 * ## Why it lives in `apps/worker/src/tools`
 *
 * It has to run **inside the VPC**, because the database is not publicly reachable,
 * and the only thing already there that can reach it is the worker image.
 * `Dockerfile.worker` copies `apps/worker/src`, so putting the tool under `src/tools`
 * ships it with no Dockerfile change and with the same allow-list the `imageClosure`
 * test already enforces. It is a command override
 * of the same image, which also means it is the same code, the same dependency set and
 * the same configuration reader as the worker that will run afterwards.
 *
 * ## What it prints
 *
 * One JSON object on stdout per command, and `--report <path>` writes the same bytes
 * to a file. Refusals and errors go to stderr as one JSON line each,
 * in the log shape the CloudWatch metric filters parse, and the exit code says which:
 * 20 for a refusal the operator has to act on, 21 for a failure, 64 for a usage error.
 *
 * Nothing here prints an environment variable's value, a connection string or a
 * secret, including in an error.
 */

export const FSS_EXIT_CODES = Object.freeze({ ok: 0, refused: 20, failed: 21, usage: 64 });

/**
 * The commands `infra/scripts/release-deploy.sh` runs on the *migration* task definition,
 * which injects `MIGRATION_DATABASE_SECRET` and `FSS_RUNTIME_DATABASE_SECRET_ARN` and, by
 * design, no `DATABASE_SECRET_ARN` (infra/modules/cluster, `migration_task_secrets`).
 * They read their configuration with the runtime connection optional and work through
 * the migration session alone; every other command still refuses without the
 * application's connection, up front. The list is code rather than a comment because
 * `fss admin database-users ensure` was refused on 23 September 2026 (run 35883201716)
 * for exactly the reason `fss migrate` had been the run before, and
 * `apps/worker/test/fssCli.test.ts` reads the script to keep the two in step.
 */
export const MIGRATION_IDENTITY_COMMANDS: readonly string[] = Object.freeze([
  'migrate',
  'migrate up',
  'admin database-users ensure',
]);

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * The tool's logger, and it writes to **stderr**.
 *
 * Everything the caller parses is on stdout — one JSON object — so a log line there
 * would corrupt the answer. The shape is the
 * same JSON the metric filters in `infra/modules/observability` read, because when
 * this runs as a one-off task it lands in the same log group as the worker.
 */
function toolLogger(instanceKey: string): Logger {
  return createLogger({
    component: 'fss',
    instanceKey,
    write: line => void process.stderr.write(`${line}\n`),
  });
}

/** Adapt one `node-postgres` client to the narrow session the domain code takes. */
function asSession(client: pg.Client): SessionQueryable {
  return {
    async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

/**
 * The Gmail adapters, resolved exactly as the worker's bootstrap resolves them.
 *
 * `FSS_DEPENDENCIES` decides, and there is no third way: `live` builds the real
 * clients from the deployment's configuration, `recorded` is a test's named choice, and
 * `none` leaves the mail command to refuse. The command wraps whatever this returns in
 * `readOnlyGmail` before it reads anything.
 */
async function resolveMail(
  environment: Readonly<Record<string, string | undefined>>,
  config: ToolConfig,
): Promise<{ readonly mail: AdminInvocation['mail'] } | { readonly refusal: AdminOutcome }> {
  try {
    const deployment = await readWorkerDeployment(environment as NodeJS.ProcessEnv);
    const composition = await composeHandlers(deployment, undefined, {
      ...(config.region === null ? {} : { region: config.region }),
    });
    return { mail: composition.mail };
  } catch (error) {
    // A deployment missing a part is a refusal an operator can act on, not a crash:
    // the message names the variable the bootstrap named and never its value.
    return {
      refusal: {
        ok: false,
        reason: 'deployment_incomplete',
        detail: error instanceof DeploymentConfigError ? `${error.code}: ${error.message}` : 'the deployment could not be read',
      },
    };
  }
}

async function resolveJournalSource(config: ToolConfig): Promise<AdminInvocation['journalSource']> {
  if (config.journalBucket === null || config.region === null) return undefined;
  return await loadS3JournalSource({ bucket: config.journalBucket, region: config.region });
}

type AdminRunner = (invocation: AdminInvocation) => Promise<AdminOutcome>;

const ADMIN_COMMANDS: Readonly<Record<string, AdminRunner>> = Object.freeze({
  'holds list': holdsListCommand,
  'suppression-journal replay': suppressionJournalReplayCommand,
  'mailbox reconcile-sent': mailboxReconcileSentCommand,
  'release-record put': releaseRecordPutCommand,
  'release-record show': releaseRecordShowCommand,
  'schema-preflight 0019': schemaPreflight0019Command,
});

async function report(path: string | undefined, value: unknown): Promise<void> {
  if (path === undefined) return;
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * `--selftest`: read the configuration, print the decisions, exit. No database, no
 * AWS, no Gmail — the same contract both binaries' `--selftest` keeps, so the images
 * workflow can prove this tool loads inside the container it ships in.
 */
async function selftest(environment: Readonly<Record<string, string | undefined>>): Promise<number> {
  const log = toolLogger('selftest');
  let config: ToolConfig;
  try {
    config = readToolConfig(environment);
  } catch (error) {
    log.log('error', 'fss_configuration_refused', {
      ...errorFields(error),
      code: error instanceof ConfigError ? error.code : null,
    });
    return FSS_EXIT_CODES.refused;
  }
  log.log('info', 'fss_selftest', { ...describeToolConfig(config), commands: Object.keys(ADMIN_COMMANDS).length });
  return FSS_EXIT_CODES.ok;
}

/**
 * Everything one command needs, resolved according to its declared dependency mode.
 *
 * A `database` command is handed no adapters at all, which is the point: it cannot
 * reach Gmail, KMS or S3 even in a fully configured production task. A `gmail-read`
 * command is handed the deployment's Gmail seam (`live` or `recorded`, refused under any
 * other word), which it only ever reads through `readOnlyGmail`.
 */
async function adminInvocation(
  name: string,
  parsed: ParsedFssCommand,
  session: SessionQueryable,
  config: ToolConfig,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<AdminInvocation | { readonly refusal: AdminOutcome }> {
  const mode = COMMAND_DEPENDENCIES[name] ?? 'database';
  const base: AdminInvocation = {
    session,
    config,
    environment,
    options: parsed.options,
    switches: parsed.switches,
  };
  if (mode === 'database') return base;
  if (mode === 'journal') {
    return { ...base, journalSource: await resolveJournalSource(config) };
  }
  if (config.dependencies !== 'live' && config.dependencies !== 'recorded') {
    return {
      refusal: {
        ok: false,
        reason: 'dependencies_none',
        detail: `fss admin ${name} reads Gmail and needs FSS_DEPENDENCIES=live (production) or recorded (a test); this deployment says ${config.dependencies ?? 'nothing'}`,
      },
    };
  }
  const resolved = await resolveMail(environment, config);
  if ('refusal' in resolved) return resolved;
  return { ...base, mail: resolved.mail };
}

async function runCommand(
  parsed: ParsedFssCommand,
  session: SessionQueryable | null,
  migrationSession: SessionQueryable | null,
  config: ToolConfig,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<AdminOutcome> {
  const { spec, options, switches } = parsed;
  const path = spec.path.join(' ');

  if (path === 'migrate' || path === 'migrate up') {
    if (migrationSession === null) return missingMigrationCredential();
    const outcome = await runMigrate(migrationSession, { allowAnyRole: switches.has('--allow-any-role') });
    return outcome.ok ? { ok: true, value: { ...outcome.value } } : { ok: false, reason: outcome.reason, detail: outcome.detail };
  }
  if (path === 'admin database-users ensure') {
    // On the migration task, as the migration credential: creating a login role is not
    // something the application's own user may do, and the runtime credential is the
    // one this command is about to make work.
    if (migrationSession === null) return missingMigrationCredential();
    const variable = options['--runtime-secret'] ?? RUNTIME_SECRET_VARIABLE;
    const secretValue = environment[variable]?.trim();
    if (secretValue === undefined || secretValue.length === 0) {
      return {
        ok: false,
        reason: 'secret_variable_missing',
        detail: `${variable} is not set; --runtime-secret names the environment variable the runtime credential's secret value is injected into, never the credential itself`,
      };
    }
    const outcome = await ensureRuntimeDatabaseUser(migrationSession, {
      secretValue,
      rotatePassword: switches.has('--rotate-password'),
    });
    return outcome.ok
      ? { ok: true, value: { ...outcome.value } }
      : { ok: false, reason: outcome.reason, detail: outcome.detail };
  }
  // The two commands above are MIGRATION_IDENTITY_COMMANDS: they run on the migration
  // task definition, which injects no runtime connection. Everything below needs one.
  if (session === null) return missingRuntimeCredential();
  if (path === 'migrate status' || path === 'schema-version') {
    return { ok: true, value: { ...(await readSchemaVersionReport(session)) } };
  }
  if (path === 'verify') {
    const outcome = await runVerify(session, config, {
      ...(options['--actor'] === undefined ? {} : { actor: options['--actor'] }),
      ...(options['--note'] === undefined ? {} : { note: options['--note'] }),
    });
    return outcome.ok ? { ok: true, value: { ...outcome.value } } : { ok: false, reason: outcome.reason, detail: outcome.detail };
  }
  if (path === 'admin workspace bootstrap') {
    // The runtime identity, like `verify`, and deliberately **not** a
    // MIGRATION_IDENTITY_COMMAND: it writes three business rows with the credential
    // the services use, which is the credential whose privileges on those tables are
    // the thing worth proving. The migration user never touches business data.
    const outcome = await bootstrapWorkspace(session, {
      slug: options['--slug'] ?? '',
      displayName: options['--display-name'] ?? '',
      adminEmail: options['--admin-email'] ?? '',
      ...(options['--time-zone'] === undefined ? {} : { timeZone: options['--time-zone'] }),
      ...(options['--sending-domain'] === undefined ? {} : { sendingDomain: options['--sending-domain'] }),
    });
    return outcome.ok
      ? { ok: true, value: { ...outcome.value } }
      : { ok: false, reason: outcome.reason, detail: outcome.detail };
  }
  const name = spec.path.slice(1).join(' ');
  const admin = ADMIN_COMMANDS[name];
  if (admin === undefined) return { ok: false, reason: 'command_unimplemented', detail: path };

  const resolved = await adminInvocation(name, parsed, session, config, environment);
  if ('refusal' in resolved) return resolved.refusal;
  return await admin(resolved);
}

function missingRuntimeCredential(): AdminOutcome {
  return {
    ok: false,
    reason: 'runtime_credential_missing',
    detail: `every command but migrate connects with the application's credential: set ${TOOL_ENVIRONMENT_VARIABLES.databaseUrl}, or inject ${TOOL_ENVIRONMENT_VARIABLES.databaseSecret} through the task definition's secrets block`,
  };
}

function missingMigrationCredential(): AdminOutcome {
  return {
    ok: false,
    reason: 'migration_credential_missing',
    detail: `migrations are applied with the migration user's own credential: set ${TOOL_ENVIRONMENT_VARIABLES.migrationDatabaseUrl}, or inject ${TOOL_ENVIRONMENT_VARIABLES.migrationDatabaseSecret} from fss-<env>/database-migration-user. The runtime DATABASE_URL is never used for this.`,
  };
}

export async function main(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  if (argv.includes('--selftest')) return await selftest(environment);

  const parsed = parseFssCommand(argv);
  if (!parsed.ok) {
    console.error(JSON.stringify({ level: 'error', event: 'fss_usage', reason: parsed.reason, detail: parsed.detail }));
    if (parsed.reason === 'command_missing') console.error(describeCommands());
    return FSS_EXIT_CODES.usage;
  }

  const log = toolLogger(parsed.value.spec.path.join('-'));
  // The migration task definition carries the migration credential and nothing the
  // application connects with, so the commands that run on it read their configuration
  // with the runtime connection optional. Every other command still refuses without
  // one, up front.
  const commandPath = parsed.value.spec.path.join(' ');
  const migrationIdentity = MIGRATION_IDENTITY_COMMANDS.includes(commandPath);
  let config: ToolConfig;
  try {
    config = readToolConfig(environment, { runtimeConnection: migrationIdentity ? 'optional' : 'required' });
  } catch (error) {
    log.log('error', 'fss_configuration_refused', {
      ...errorFields(error),
      code: error instanceof ConfigError ? error.code : null,
    });
    return FSS_EXIT_CODES.refused;
  }

  const client =
    config.database === null
      ? null
      : new pg.Client({ connectionString: config.database.connectionString, application_name: 'fss-admin' });
  if (client !== null) await client.connect();
  const session = client === null ? null : asSession(client);
  // The migration credential is opened only when it exists, and it is a second
  // connection rather than a reused one: `migrate` runs as the migration user and every
  // other command runs as the application's.
  const migrationClient =
    config.migrationDatabase === null
      ? null
      : new pg.Client({
          connectionString: config.migrationDatabase.connectionString,
          application_name: 'fss-migrate',
        });
  try {
    if (migrationClient !== null) await migrationClient.connect();
    const outcome = await runCommand(
      parsed.value,
      session,
      migrationClient === null ? null : asSession(migrationClient),
      config,
      environment,
    );
    if (!outcome.ok) {
      log.log('error', 'fss_refused', { command: parsed.value.spec.path.join(' '), reason: outcome.reason, detail: outcome.detail });
      // A refusal that got somewhere prints how far, on stdout where the caller reads
      // answers. The exit code is still 20: a report is not a pass.
      if (outcome.report !== undefined) {
        await report(parsed.value.options['--report'], outcome.report);
        write(JSON.stringify(outcome.report));
      }
      return FSS_EXIT_CODES.refused;
    }
    await report(parsed.value.options['--report'], outcome.value);
    write(JSON.stringify(outcome.value));
    return FSS_EXIT_CODES.ok;
  } catch (error) {
    // Never the message alone: a `pg` error can carry a statement, and a deployment
    // error names a variable. `errorFields` is what both binaries log.
    log.log('error', 'fss_failed', { command: parsed.value.spec.path.join(' '), ...errorFields(error), code: error instanceof DeploymentConfigError ? error.code : null });
    return FSS_EXIT_CODES.failed;
  } finally {
    if (client !== null) await client.end().catch(() => undefined);
    if (migrationClient !== null) await migrationClient.end().catch(() => undefined);
  }
}

// `import.meta.url` equals the resolved entry point only when this file was run
// directly, which is how the container's command override starts it and how a test
// may import it.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
