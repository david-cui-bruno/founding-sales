import { classifyMigration, renderClassification } from './classify.ts';

/** The entry point `infra/scripts/classify-migration.sh` runs. */
function main(argv: readonly string[]): number {
  const file = argv[0];
  if (file === undefined || file === '--help' || argv.length > 2) {
    process.stderr.write('usage: classify-migration.sh <migration.sql> [--applied-on=N]\n');
    return 2;
  }
  let appliedOn: number | undefined;
  const flag = argv[1];
  if (flag !== undefined) {
    const value = /^--applied-on=(\d+)$/u.exec(flag);
    if (value?.[1] === undefined) {
      process.stderr.write('usage: classify-migration.sh <migration.sql> [--applied-on=N]\n');
      return 2;
    }
    appliedOn = Number(value[1]);
  }
  try {
    process.stdout.write(`${renderClassification(classifyMigration(file, appliedOn === undefined ? {} : { appliedOn }))}\n`);
  } catch (error) {
    process.stderr.write(`classify-migration: ${error instanceof Error ? error.message : 'failed'}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
