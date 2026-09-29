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

// The deployed-range comparison lives in a module of its own because the CI guard runs
// it as a script, before `npm ci`, and must therefore not drag in anything this file
// imports. Re-exported here so every existing caller is unaffected.
export { compareDeployedMigrations, type DeployedMigrationDifference } from './deployedMigrations.ts';

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


