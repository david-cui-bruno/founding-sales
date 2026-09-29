import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import {
  applyMigrations,
  loadMigrations,
  readAppliedSchemaVersion,
  type AppliedMigration,
} from '@fss/domain/db/migrationRunner.ts';
// Relative, not `@fss/worker/...`: this file is copied into, and run from, checkouts
// whose `apps/worker/package.json` exports only `.`, and a package specifier does not
// resolve there. A relative path resolves inside whichever tree the file is in, which
// is exactly the property the two-checkout arrangement needs.
import { APP_RUNTIME_ROLE, MIGRATION_ROLE, readMigrationRole } from '../../apps/worker/src/tools/fss/migrate.ts';

/**
 * Applying migrations the way a release applies them.
 *
 * `runMigrate` (`fss migrate`) is the command production runs, and its two refusals are
 * the thing worth reusing: a session that is `app_runtime` may never apply DDL, and a
 * session that is not a member of `migration` may not either once that role exists.
 * Those checks are made here through `readMigrationRole`, the same function, and the
 * apply itself goes through `applyMigrations`, the same runner.
 *
 * What is *not* reused is `runMigrate`'s call shape: it takes no migrations directory
 * and no ceiling, because a deployed image only ever applies its own files to the end.
 * This test has to stop at N, and has to be able to read another tree's files
 * (`--migrations`), so it passes both to `applyMigrations` directly.
 */

export type MigrateRefusal = 'runs_as_app_runtime' | 'not_migration_role';

export interface ApplyReport {
  readonly before: number;
  readonly after: number;
  readonly applied: readonly AppliedMigration[];
  readonly connectedRole: string;
  readonly migrationRoleExists: boolean;
}

export class MigrateRefused extends Error {
  constructor(readonly refusal: MigrateRefusal, message: string) {
    super(message);
    this.name = 'MigrateRefused';
  }
}

export interface ApplyOptions {
  readonly directory: string;
  readonly throughVersion?: number | undefined;
}

export async function applyAs(session: SessionQueryable, options: ApplyOptions): Promise<ApplyReport> {
  const role = await readMigrationRole(session);
  if (role.isAppRuntimeRole) {
    throw new MigrateRefused(
      'runs_as_app_runtime',
      `this session is ${APP_RUNTIME_ROLE}; migrations are applied with the migration credential`,
    );
  }
  if (role.migrationRoleExists && !role.isMigrationRole) {
    throw new MigrateRefused(
      'not_migration_role',
      `the connected role is not a member of ${MIGRATION_ROLE}`,
    );
  }
  const before = await readAppliedSchemaVersion(session);
  const applied = await applyMigrations(session, {
    migrations: loadMigrations(options.directory),
    ...(options.throughVersion === undefined ? {} : { throughVersion: options.throughVersion }),
  });
  return {
    before,
    after: await readAppliedSchemaVersion(session),
    applied,
    connectedRole: role.connectedRole,
    migrationRoleExists: role.migrationRoleExists,
  };
}

/**
 * A copy of `directory` with one extra migration that is valid up to its second
 * statement and then is not.
 *
 * The recovery case the release procedure claims and nothing has ever demonstrated:
 * each migration is applied in its own transaction, so a file that fails halfway leaves
 * the schema exactly where it was. The first statement has to be real DDL — a file that
 * fails on its first token proves only that the parser works.
 */
export async function withFailingMigration(directory: string, version: number): Promise<{ readonly directory: string; readonly fileName: string }> {
  const copy = await mkdtemp(join(tmpdir(), 'fss-upgrade-migrations-'));
  await cp(directory, copy, { recursive: true });
  const fileName = `${String(version).padStart(4, '0')}_upgrade_test_failure.sql`;
  await writeFile(
    join(copy, fileName),
    [
      '-- Written by `npm run upgrade:test` into a temporary copy of the migrations',
      '-- directory. It is never committed and never applied to anything but the test',
      '-- database: its second statement is invalid on purpose, so that the runner has',
      '-- to roll the first one back.',
      '-- changes: none',
      'CREATE TABLE upgrade_test_failure_probe (id integer PRIMARY KEY);',
      'ALTER TABLE upgrade_test_failure_probe ADD COLUMN broken no_such_type_exists;',
      '',
    ].join('\n'),
    'utf8',
  );
  return { directory: copy, fileName };
}

/**
 * The membership `fss migrate` needs, which `database-users ensure` does not give it.
 *
 * PostgreSQL 16 grants a role created by a `CREATEROLE` user back to its creator with
 * `ADMIN TRUE, INHERIT FALSE, SET FALSE`. Migration 0001 creates `migration` and
 * `app_runtime`, and on a real instance it runs as the RDS master, which is such a
 * user. So afterwards:
 *
 *   * `databaseUsers.ts` asks `pg_has_role(current_user, 'migration', 'MEMBER')`, which
 *     that automatic grant makes **true**, reports `migrationMembership: 'already'` and
 *     issues no `GRANT`;
 *   * `migrate.ts` asks `pg_has_role(current_user, 'migration', 'USAGE')`, which an
 *     `INHERIT FALSE` membership makes **false**, and every `fss migrate` after the
 *     first one is refused `not_migration_role`.
 *
 * The old rehearsal could not see this: it migrated an empty database exactly once, and
 * on the first run the role does not exist yet, which is the case `readMigrationRole`
 * deliberately lets through. An upgrade test migrates twice by construction, which is
 * how it turned up.
 *
 * This function is the test's way past it, not a fix: it makes the membership inherit,
 * as a `GRANT migration TO <migrator>` issued by `database-users ensure` would have, and
 * says whether it had to. The report prints that sentence whenever it did.
 */
export async function ensureMigrationMembershipInherits(
  owner: SessionQueryable,
  migrator: SessionQueryable,
): Promise<{ readonly repaired: boolean; readonly detail: string }> {
  const role = await readMigrationRole(migrator);
  if (!role.migrationRoleExists || role.isMigrationRole) {
    return { repaired: false, detail: `${role.connectedRole} already carries ${MIGRATION_ROLE}'s privileges` };
  }
  const { rows } = await owner.query<{ inherit: boolean | null }>(
    `SELECT a.inherit_option AS inherit
       FROM pg_auth_members a
       JOIN pg_roles r ON r.oid = a.roleid
       JOIN pg_roles m ON m.oid = a.member
      WHERE r.rolname = $1 AND m.rolname = $2`,
    [MIGRATION_ROLE, role.connectedRole],
  );
  const membership = rows[0];
  await owner.query(`GRANT ${MIGRATION_ROLE} TO "${role.connectedRole}" WITH INHERIT TRUE`);
  return {
    repaired: true,
    detail:
      membership === undefined
        ? `${role.connectedRole} was not a member of ${MIGRATION_ROLE} at all`
        : `${role.connectedRole}'s membership of ${MIGRATION_ROLE} had INHERIT ${String(membership.inherit)}, so \`fss migrate\` refuses it as not_migration_role`,
  };
}
