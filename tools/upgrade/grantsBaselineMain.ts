import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyMigrations, loadMigrations, readAppliedSchemaVersion } from '@fss/domain/db/migrationRunner.ts';
// Relative, not `@fss/worker/...`, for the reason `migrate.ts` gives: this directory is
// copied into, and run from, checkouts whose `apps/worker/package.json` exports only
// `.`, where a package specifier does not resolve.
import { ensureRuntimeDatabaseUser } from '../../apps/worker/src/tools/fss/databaseUsers.ts';
import { createUpgradeDatabase, MIGRATOR_LOGIN_ROLE } from './cluster.ts';
import { capturePrivileges, serialiseGrantsBaseline } from './grants.ts';

/**
 * `node --experimental-transform-types --disable-warning=ExperimentalWarning tools/upgrade/grantsBaselineMain.ts [path]`
 *
 * Writes `tools/upgrade/grants-baseline.json`: the privilege state of a database that
 * has had every migration in this checkout applied to it and has had
 * `fss admin database-users ensure` run against it.
 *
 * **Run by hand, not by CI, and only when a schema release changes the baseline.** The
 * upgrade test asks whether the privileges at M equal the baseline plus the GRANT and
 * REVOKE statements of the migrations since it (`tools/upgrade/grants.ts`), so a schema
 * release that legitimately changes who may reach what fails that check until somebody
 * regenerates this file — and **the diff is the review artefact**. A regenerated
 * baseline whose diff nobody read is the same as no baseline at all: the whole point is
 * that a lost permission or a table nobody granted anything on has to appear as a line
 * a reviewer approved, rather than as an expectation that silently moved.
 *
 * The file is deterministic: every list is sorted, the object's owner is written as the
 * literal `OWNER` rather than by name, and nothing about the throwaway cluster — its
 * port, its database name, its generated passwords — reaches the output. Regenerating
 * without changing the migrations produces the same bytes.
 *
 * It costs one embedded PostgreSQL 16 and no network; there is nothing here that can
 * reach a real database.
 */

/** The migrator is the database's and the schema's owner, and the role a release migrates as. */
async function main(): Promise<number> {
  const target = process.argv[2] ?? fileURLToPath(new URL('./grants-baseline.json', import.meta.url));
  const migrations = fileURLToPath(new URL('../../packages/domain/db/migrations', import.meta.url));

  const cluster = await createUpgradeDatabase();
  try {
    // As `fss_migrator`, not as the cluster superuser: the migrator owns the database
    // and the schema (`cluster.ts`), so every object a migration creates is owned by it,
    // exactly as in the upgrade test and on a real instance. A superuser session would
    // leave the objects owned by somebody production has none of.
    const owner = await cluster.connect(MIGRATOR_LOGIN_ROLE);

    await applyMigrations(owner.session, { migrations: loadMigrations(migrations) });
    const schemaVersion = await readAppliedSchemaVersion(owner.session);

    // The runtime login has to exist before the privileges are read: the baseline is
    // about a database in the state production leaves it in, and `database-users ensure`
    // is part of that state.
    const users = await ensureRuntimeDatabaseUser(owner.session, { secretValue: cluster.runtimeSecretValue });
    if (!users.ok) {
      process.stderr.write(`database-users ensure refused: ${users.reason} — ${users.detail}\n`);
      return 1;
    }

    const baseline = await capturePrivileges(owner.session, schemaVersion);
    writeFileSync(target, serialiseGrantsBaseline(baseline), 'utf8');
    process.stdout.write(
      `grants baseline at schema ${String(schemaVersion)} written to ${target}\n` +
        `  ${String(baseline.tables.length)} table(s), ${String(baseline.tableGrants.length)} table grant(s), ` +
        `${String(baseline.publicGrants.length)} PUBLIC, ${String(baseline.sequenceGrants.length)} sequence, ` +
        `${String(baseline.routineGrants.length)} routine, ${String(baseline.schemaGrants.length)} schema\n` +
        '  review the diff: a permission that disappeared from it is a permission the application lost\n',
    );
    return 0;
  } finally {
    await cluster.drop().catch(() => undefined);
    await cluster.stop().catch(() => undefined);
  }
}

process.exitCode = await main();
