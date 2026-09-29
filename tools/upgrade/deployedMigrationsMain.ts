import { compareDeployedMigrations } from './deployedMigrations.ts';

/**
 * The deployed-range comparison, as a script, for the `upgrade` job's guard.
 *
 * The guard has to answer "may this branch skip the upgrade test?" before it installs
 * anything, and the only honest answer compares the bytes two checkouts would present
 * to the migration runner. It used to do that in shell, against git blob ids, which is
 * a different question (GPT-6, third review of PR 314, P0-1). This is the tool's own
 * comparison, run over the two real checkouts, so there is one implementation of the
 * rule and not two.
 *
 * Exits 0 when the deployed range is identical, 1 when it is not or when either
 * directory holds a `.sql` file the runner would refuse to load.
 *
 *   node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *     tools/upgrade/deployedMigrationsMain.ts --base <dir> --head <dir> --through <N>
 *
 * The two directories are repository roots, not migrations directories: the guard has
 * checkouts, and naming the checkout keeps the path rule in one place.
 */

const MIGRATIONS_PATH = 'packages/domain/db/migrations';

function argumentValue(argv: readonly string[], name: string): string {
  const at = argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`deployed-migrations: --${name} <value> is required\n`);
    process.exit(2);
  }
  return value;
}

const argv = process.argv.slice(2);
const base = argumentValue(argv, 'base');
const head = argumentValue(argv, 'head');
const throughText = argumentValue(argv, 'through');
if (!/^\d+$/u.test(throughText)) {
  process.stderr.write(`deployed-migrations: --through ${throughText} is not a schema version\n`);
  process.exit(2);
}
const through = Number(throughText);

try {
  const differences = compareDeployedMigrations(`${base}/${MIGRATIONS_PATH}`, `${head}/${MIGRATIONS_PATH}`, through);
  if (differences.length === 0) {
    process.stdout.write(`the ${String(through)} deployed migration(s) are byte-identical in both checkouts\n`);
    process.exit(0);
  }
  process.stderr.write(`migrations at or below the deployed schema ${String(through)} differ from the deployed bytes:\n`);
  for (const difference of differences) {
    const reason =
      difference.reason === 'missing_in_head'
        ? 'deployed, and this branch does not have it'
        : difference.reason === 'missing_in_base'
          ? 'this branch adds it below the deployed schema, where production has already recorded which files it applied'
          : `content differs (deployed sha256 ${difference.baseChecksum?.slice(0, 12) ?? '?'}…, this branch ${difference.headChecksum?.slice(0, 12) ?? '?'}…)`;
    process.stderr.write(`  ${difference.fileName}: ${reason}\n`);
  }
  process.stderr.write(
    'migrations are immutable once applied; production would refuse this with MIGRATION_CHECKSUM_MISMATCH\n',
  );
  process.exit(1);
} catch (error) {
  // `loadMigrations` throws the runner's own `MIGRATION_FILE_NAME_INVALID` here, which
  // is the point: a name production would refuse is not a name this job may skip over.
  process.stderr.write(`deployed-migrations: ${error instanceof Error ? error.message : 'the comparison failed'}\n`);
  process.exit(1);
}
