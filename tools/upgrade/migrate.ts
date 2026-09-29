import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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


export interface DeployedMigrationDifference {
  readonly fileName: string;
  readonly reason: 'content_differs' | 'missing_in_head' | 'missing_in_base';
  readonly baseChecksum: string | null;
  readonly headChecksum: string | null;
}

/**
 * Every migration up to `through` must be byte-identical in the two checkouts.
 *
 * The runner records a sha256 of each file's bytes and refuses to continue when a
 * recorded file has changed (`MIGRATION_CHECKSUM_MISMATCH`), because migrations are
 * forward-only and there is nothing to fall back to. A branch that edits an already
 * deployed file and adds a new one would therefore be *refused by production* — and
 * would have passed this test, which applied HEAD's copy of the old file and recorded
 * HEAD's checksum for it.
 *
 * So the deployed range is compared before anything is applied, and the answer is the
 * same one production would give. The runner is still the backstop: 1..N are applied
 * from the base checkout and N+1..M from HEAD, so a difference this function somehow
 * missed fails again, with the runner's own error, at the second apply.
 */
export function compareDeployedMigrations(
  baseDirectory: string,
  headDirectory: string,
  through: number,
): readonly DeployedMigrationDifference[] {
  const checksum = (sql: string): string => createHash('sha256').update(sql, 'utf8').digest('hex');
  const upTo = (directory: string): Map<string, string> =>
    new Map(
      loadMigrations(directory)
        .filter(migration => migration.version <= through)
        .map(migration => [migration.fileName, checksum(readFileSync(join(directory, migration.fileName), 'utf8'))]),
    );
  const base = upTo(baseDirectory);
  const head = upTo(headDirectory);
  const differences: DeployedMigrationDifference[] = [];
  for (const [fileName, baseChecksum] of base) {
    const headChecksum = head.get(fileName);
    if (headChecksum === undefined) {
      differences.push({ fileName, reason: 'missing_in_head', baseChecksum, headChecksum: null });
      continue;
    }
    if (headChecksum !== baseChecksum) {
      differences.push({ fileName, reason: 'content_differs', baseChecksum, headChecksum });
    }
  }
  for (const [fileName, headChecksum] of head) {
    if (!base.has(fileName)) {
      differences.push({ fileName, reason: 'missing_in_base', baseChecksum: null, headChecksum });
    }
  }
  return differences.sort((left, right) => left.fileName.localeCompare(right.fileName));
}
