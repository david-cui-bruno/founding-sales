import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { ConfigError } from '../../bootstrap/config.ts';
import { APP_RUNTIME_ROLE, MIGRATION_ROLE } from './migrate.ts';

/**
 * `fss admin database-users ensure` (David's decision of 21 September, condition 3).
 *
 * Today both services connect as the RDS master user. G12h moves them to a dedicated
 * login user whose credential lives in its own secret, and this is the command that
 * makes that user exist — on the migration task, as the migration user, because
 * creating a role is not something the application's own credential may do.
 *
 * ## What it does and what it refuses to do
 *
 * Migration 0001 created `app_runtime` and `migration` as `NOLOGIN` **group** roles:
 * they carry the privileges and nobody logs in as them. So the runtime user is a login
 * role that is a *member* of `app_runtime` and holds no privilege of its own, which is
 * what `LOGIN IN ROLE app_runtime` says.
 *
 * * The name and the password come from the secret's value and never from an argument.
 *   An argument list is visible in `ps` and ends up in a shell history file; a
 *   `--runtime-secret` flag therefore names the **environment variable** the ECS
 *   `secrets` block injected the value into, exactly as the carry's
 *   `--database-url-env` does.
 * * No DDL. `CREATE ROLE` and `GRANT` on a role are catalogue writes, not schema
 *   changes: this command creates no table, alters no column and applies no migration.
 * * A password is set when the role is **created**, and on an existing role only when
 *   `--rotate-password` says so. PostgreSQL cannot be asked whether a password matches,
 *   so a command that always set it would silently rotate a credential the services are
 *   holding, and one that never set it could not create the user in the first place.
 *   The report says which happened.
 *
 * Nothing here logs, prints or returns the password, including in an error: the
 * statement text carries it, so a failure is re-raised with the error's class and
 * nothing else.
 *
 * ## The second thing it does, and why it is here rather than in a migration
 *
 * `migration-database` holds the RDS **master** user's credentials, because on a fresh
 * instance that is the only credential that exists — 0001 creates `app_runtime` and
 * `migration` as NOLOGIN group roles, so there is no login user to put in a secret
 * until this command makes one. The master is not a PostgreSQL superuser, so
 * `fss migrate`'s membership check is a real check, and on the very first run it passes
 * only because the `migration` role does not exist yet. So this command also grants
 * `migration` to the connected user, once, and every later `fss migrate` then passes
 * that check for a reason rather than by the absence of one.
 *
 * It refuses when `app_runtime` or `migration` is missing, which means `fss migrate`
 * has not run. There is no migration number here and no SQL file: a role grant is not
 * a schema change and a database's login users are not the same thing in a rehearsal as
 * they are in production.
 */

export type DatabaseUserOutcome = 'created' | 'altered' | 'unchanged';

export type DatabaseUsersRefusal =
  | 'secret_variable_missing'
  | 'secret_malformed'
  | 'not_permitted'
  | 'roles_missing'
  | 'failed';

export interface DatabaseUserReport {
  readonly outcome: DatabaseUserOutcome;
  /** The role name. A public identifier, and the only part of the secret that is reported. */
  readonly user: string;
  readonly memberOf: string;
  readonly canLogin: boolean;
  readonly passwordSet: boolean;
}

/** Whether the connected user was already a member of `migration`, or has just been. */
export type MigrationMembership = 'granted' | 'already';

export interface DatabaseUsersReport {
  readonly user: DatabaseUserReport;
  readonly migrationMembership: MigrationMembership;
  /** Who the grant was made to. A role name is a public identifier. */
  readonly grantedTo: string;
}

export type DatabaseUsersResult =
  | { readonly ok: true; readonly value: DatabaseUsersReport }
  | { readonly ok: false; readonly reason: DatabaseUsersRefusal; readonly detail: string };

/** The environment variable the runtime credential's secret value is injected into. */
export const RUNTIME_SECRET_VARIABLE = 'FSS_RUNTIME_DATABASE_SECRET_ARN';

interface RuntimeCredential {
  readonly username: string;
  readonly password: string;
}

/**
 * The username and password out of a Secrets Manager value.
 *
 * The same JSON shape `databaseConnection` already understands — `username`,
 * `password`, `host`, `port`, `dbname` — because it is the same secret family, and a
 * second shape would be a second thing to keep in step with RDS.
 */
export function readRuntimeCredential(raw: string): RuntimeCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('INVALID', 'the runtime database secret does not hold a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('INVALID', 'the runtime database secret does not hold a JSON object');
  }
  const secret = parsed as Record<string, unknown>;
  const field = (name: string): string => {
    const value = secret[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new ConfigError('INVALID', `the runtime database secret does not carry ${name}`);
    }
    return value;
  };
  const username = field('username');
  // A role name goes into a statement as an identifier, quoted by `format('%I')` on the
  // server. The shape is still checked here, because a name that needs anything more
  // exotic than this is a name somebody should not have chosen.
  if (!/^[a-z][a-z0-9_]{2,62}$/u.test(username)) {
    throw new ConfigError('INVALID', 'the runtime database user name is not a plain lower-case identifier');
  }
  return { username, password: field('password') };
}

/**
 * Build one statement with the server's own quoting.
 *
 * `format('%I', …)` quotes an identifier and `format('%L', …)` quotes a literal, both
 * by the same rules the server parses. Doing it here rather than in TypeScript means
 * the escaping is PostgreSQL's, which is the only escaping that can be right.
 */
async function formatted(
  session: SessionQueryable,
  template: string,
  values: readonly string[],
): Promise<string> {
  // Every placeholder is cast: `format` is variadic `any`, so PostgreSQL cannot infer
  // the parameter types and refuses the statement without them.
  const { rows } = await session.query<{ statement: string }>(
    `SELECT format($1::text, ${values.map((_, index) => `$${String(index + 2)}::text`).join(', ')}) AS statement`,
    [template, ...values],
  );
  const statement = rows[0]?.statement;
  if (statement === undefined) throw new Error('the server did not format the statement');
  return statement;
}

/** Run a statement whose text carries a credential. Errors are re-raised redacted. */
async function executeOpaque(session: SessionQueryable, statement: string, what: string): Promise<void> {
  try {
    await session.query(statement);
  } catch (error) {
    throw new Error(`${what} failed: ${error instanceof Error ? error.name : 'unknown'}`);
  }
}

export interface EnsureDatabaseUserInput {
  /** The secret's value, already read from the environment by the caller. */
  readonly secretValue: string;
  readonly rotatePassword?: boolean | undefined;
}

export async function ensureRuntimeDatabaseUser(
  session: SessionQueryable,
  input: EnsureDatabaseUserInput,
): Promise<DatabaseUsersResult> {
  let credential: RuntimeCredential;
  try {
    credential = readRuntimeCredential(input.secretValue);
  } catch (error) {
    return {
      ok: false,
      reason: 'secret_malformed',
      detail: error instanceof ConfigError ? error.message : 'the runtime database secret could not be read',
    };
  }

  // The group roles have to be there: they are what the login user is a member *of*,
  // and their absence means the migrations have not run against this database.
  const groups = await session.query<{ app: boolean; migration: boolean }>(
    'SELECT to_regrole($1) IS NOT NULL AS app, to_regrole($2) IS NOT NULL AS migration',
    [APP_RUNTIME_ROLE, MIGRATION_ROLE],
  );
  const present = groups.rows[0];
  if (present?.app !== true || present.migration !== true) {
    return {
      ok: false,
      reason: 'roles_missing',
      detail: `${APP_RUNTIME_ROLE} or ${MIGRATION_ROLE} does not exist, so \`fss migrate\` has not run against this database`,
    };
  }

  const permitted = await session.query<{ createrole: boolean }>(
    'SELECT rolcreaterole AS createrole FROM pg_roles WHERE rolname = current_user',
  );
  if (permitted.rows[0]?.createrole !== true) {
    return {
      ok: false,
      reason: 'not_permitted',
      detail: 'this session may not create roles; the migration user needs CREATEROLE for this command',
    };
  }

  const existing = await session.query<{ canlogin: boolean; member: boolean }>(
    `SELECT r.rolcanlogin AS canlogin,
            pg_has_role(r.rolname, $2, 'MEMBER') AS member
       FROM pg_roles r
      WHERE r.rolname = $1`,
    [credential.username, APP_RUNTIME_ROLE],
  );
  const found = existing.rows[0];

  if (found === undefined) {
    await executeOpaque(
      session,
      await formatted(session, 'CREATE ROLE %I LOGIN PASSWORD %L IN ROLE %I', [
        credential.username,
        credential.password,
        APP_RUNTIME_ROLE,
      ]),
      'creating the runtime database user',
    );
    return await withMigrationMembership(session, {
      outcome: 'created',
      user: credential.username,
      memberOf: APP_RUNTIME_ROLE,
      canLogin: true,
      passwordSet: true,
    });
  }

  const needsLogin = !found.canlogin;
  const needsMembership = !found.member;
  const rotate = input.rotatePassword === true;
  if (!needsLogin && !needsMembership && !rotate) {
    return await withMigrationMembership(session, {
      outcome: 'unchanged',
      user: credential.username,
      memberOf: APP_RUNTIME_ROLE,
      canLogin: true,
      passwordSet: false,
    });
  }

  if (needsLogin || rotate) {
    await executeOpaque(
      session,
      rotate
        ? await formatted(session, 'ALTER ROLE %I WITH LOGIN PASSWORD %L', [credential.username, credential.password])
        : await formatted(session, 'ALTER ROLE %I WITH LOGIN', [credential.username]),
      'altering the runtime database user',
    );
  }
  if (needsMembership) {
    await executeOpaque(
      session,
      await formatted(session, 'GRANT %I TO %I', [APP_RUNTIME_ROLE, credential.username]),
      'granting the application role',
    );
  }

  return await withMigrationMembership(session, {
    outcome: 'altered',
    user: credential.username,
    memberOf: APP_RUNTIME_ROLE,
    canLogin: true,
    passwordSet: rotate,
  });
}

/**
 * Make the connected user a member of `migration`, once, and report which it was.
 *
 * The first `fss migrate` on a fresh instance runs as the RDS master and passes the
 * membership check only because the role it checks does not exist yet. This is what
 * makes every run after it pass for a reason. The master is not a superuser, so the
 * check is genuine — and this grant is what makes it satisfiable.
 */
async function withMigrationMembership(
  session: SessionQueryable,
  user: DatabaseUserReport,
): Promise<DatabaseUsersResult> {
  const { rows } = await session.query<{ role: string; member: boolean }>(
    `SELECT current_user AS role, pg_has_role(current_user, $1, 'MEMBER') AS member`,
    [MIGRATION_ROLE],
  );
  const row = rows[0];
  const grantedTo = row?.role ?? 'unknown';
  if (row?.member === true) {
    return { ok: true, value: { user, migrationMembership: 'already', grantedTo } };
  }
  await executeOpaque(
    session,
    await formatted(session, 'GRANT %I TO %I', [MIGRATION_ROLE, grantedTo]),
    'granting the migration role to the connected user',
  );
  return { ok: true, value: { user, migrationMembership: 'granted', grantedTo } };
}
