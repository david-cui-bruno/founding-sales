import type { SessionQueryable } from '@fss/domain/db';
import {
  CURRENT_SCHEMA_VERSION,
  API_SCHEMA_RANGE,
  WORKER_SCHEMA_RANGE,
  applyMigrations,
  loadMigrations,
  readAppliedSchemaVersion,
} from '@fss/domain/db';

/**
 * `fss migrate` and `fss schema-version` (specification 4.2, 16.1; Appendix E step 7).
 *
 * ## Why this command has to exist
 *
 * Nothing in this repository's deployment ever ran a migration. The release
 * workflow's step is named "migrate, then deploy the worker, then the API" and
 * `infra/scripts/rehearsal-schema-ranges.sh` redeploys the two services and nothing
 * else, while both binaries refuse to start unless the applied schema version is
 * exactly the one they declare. On a fresh database that is two services that will
 * never start and no command that would fix it. This is the command.
 *
 * ## The role check, and why it is conditional
 *
 * Migration 0001 creates `app_runtime` and `migration` as `NOLOGIN` roles and grants
 * the second one what a migration needs. So a database that has never been migrated
 * has no `migration` role to connect as, and a role check that refused would refuse
 * the first migration for ever. The check is therefore: if the role exists, the
 * connected role must be a member of it; if it does not, say so in the report and
 * carry on, because this run is what creates it.
 *
 * `SET ROLE migration` is deliberately *not* done. Object ownership would then differ
 * between a migrated production database and every test database in this repository,
 * and 0001's grants are written against roles rather than owners. The check is about
 * privilege, and the report says which role actually ran.
 */

export type MigrateRefusal = 'not_migration_role' | 'runs_as_app_runtime' | 'failed';

export interface MigrateRoleReport {
  readonly connectedRole: string;
  /** False on a database the foundation migration has not reached: there is no role yet. */
  readonly migrationRoleExists: boolean;
  readonly isMigrationRole: boolean;
  /** True when this session is the application's role, which may never apply DDL. */
  readonly isAppRuntimeRole: boolean;
}

export interface MigrateReport {
  readonly schemaVersionBefore: number;
  readonly schemaVersionAfter: number;
  readonly applied: readonly { readonly version: number; readonly name: string }[];
  readonly currentSchemaVersion: number;
  readonly role: MigrateRoleReport;
}

export type MigrateResult =
  | { readonly ok: true; readonly value: MigrateReport }
  | { readonly ok: false; readonly reason: MigrateRefusal; readonly detail: string };

/** The role that applies migrations. The same name `db/testing` and 0001 use. */
export const MIGRATION_ROLE = 'migration';
/** The application's role. It may never apply DDL, whatever a flag says. */
export const APP_RUNTIME_ROLE = 'app_runtime';

export async function readMigrationRole(session: SessionQueryable): Promise<MigrateRoleReport> {
  const { rows } = await session.query<{ role: string; exists: boolean }>(
    `SELECT current_user AS role, to_regrole($1) IS NOT NULL AS exists`,
    [MIGRATION_ROLE],
  );
  const row = rows[0];
  const connectedRole = row?.role ?? 'unknown';
  const migrationRoleExists = row?.exists === true;
  const isAppRuntimeRole = connectedRole === APP_RUNTIME_ROLE;
  if (!migrationRoleExists || isAppRuntimeRole) {
    // No second query when the answer cannot change the decision: a database with no
    // `migration` role has no membership to read, and `app_runtime` is refused whatever
    // it is a member of.
    return { connectedRole, migrationRoleExists, isMigrationRole: false, isAppRuntimeRole };
  }
  const member = await session.query<{ member: boolean }>('SELECT pg_has_role(current_user, $1, $2) AS member', [
    MIGRATION_ROLE,
    'USAGE',
  ]);
  return {
    connectedRole,
    migrationRoleExists,
    isMigrationRole: member.rows[0]?.member === true,
    isAppRuntimeRole,
  };
}

export interface MigrateOptions {
  /**
   * Run even though the connected role is not the migration role. For the one case
   * that is not a mistake: a superuser repairing a database whose roles are wrong.
   * It is a flag rather than a default because the default has to be the refusal.
   */
  readonly allowAnyRole?: boolean | undefined;
}

export async function runMigrate(session: SessionQueryable, options: MigrateOptions = {}): Promise<MigrateResult> {
  const role = await readMigrationRole(session);
  // Unconditional, and before the flag is read: `--allow-any-role` is for a superuser
  // repairing a database, never for the application's own credential. A migration
  // applied as `app_runtime` either fails halfway or succeeds because somebody granted
  // the application DDL, and the second is worse than the first.
  if (role.isAppRuntimeRole) {
    return {
      ok: false,
      reason: 'runs_as_app_runtime',
      detail: `this session is ${APP_RUNTIME_ROLE}; migrations are applied with the migration credential (FSS_MIGRATION_DATABASE_URL or MIGRATION_DATABASE_SECRET)`,
    };
  }
  if (role.migrationRoleExists && !role.isMigrationRole && options.allowAnyRole !== true) {
    return {
      ok: false,
      reason: 'not_migration_role',
      detail: `the connected role is not a member of ${MIGRATION_ROLE}; --allow-any-role says so deliberately`,
    };
  }

  const schemaVersionBefore = await readAppliedSchemaVersion(session);
  const applied = await applyMigrations(session);
  const schemaVersionAfter = await readAppliedSchemaVersion(session);

  return {
    ok: true,
    value: {
      schemaVersionBefore,
      schemaVersionAfter,
      applied: applied.map(migration => ({ version: migration.version, name: migration.name })),
      currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      // Re-read after the run: the role the migration created is the role the next one
      // must be, and an operator reading the report needs to see which it was.
      role: role.migrationRoleExists ? role : await readMigrationRole(session),
    },
  };
}

export interface SchemaVersionReport {
  readonly schemaVersion: number;
  readonly currentSchemaVersion: number;
  readonly pending: readonly number[];
  readonly api: { readonly minimum: number; readonly maximum: number };
  readonly worker: { readonly minimum: number; readonly maximum: number };
  readonly apiAccepts: boolean;
  readonly workerAccepts: boolean;
}

/**
 * `fss schema-version` and `fss migrate status`. Reads only, and says whether each
 * binary would start: that is the question the drill's step 7 asks of the ranges, and
 * an operator asking it should not have to run an image to find out.
 */
export async function readSchemaVersionReport(session: SessionQueryable): Promise<SchemaVersionReport> {
  const schemaVersion = await readAppliedSchemaVersion(session);
  const pending = loadMigrations()
    .filter(migration => migration.version > schemaVersion)
    .map(migration => migration.version);
  return {
    schemaVersion,
    currentSchemaVersion: CURRENT_SCHEMA_VERSION,
    pending,
    api: { minimum: API_SCHEMA_RANGE.minimum, maximum: API_SCHEMA_RANGE.maximum },
    worker: { minimum: WORKER_SCHEMA_RANGE.minimum, maximum: WORKER_SCHEMA_RANGE.maximum },
    apiAccepts: schemaVersion >= API_SCHEMA_RANGE.minimum && schemaVersion <= API_SCHEMA_RANGE.maximum,
    workerAccepts: schemaVersion >= WORKER_SCHEMA_RANGE.minimum && schemaVersion <= WORKER_SCHEMA_RANGE.maximum,
  };
}
