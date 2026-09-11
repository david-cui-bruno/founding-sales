import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
try {
  const { parseExplicitPaths } = require('../build/generated/operational-tools/readOnlyEncryptedDatabase.cjs');
  const { auditIdentityMigrationFiles } = require('../build/generated/operational-tools/identityMigrationAudit.cjs');
  const paths = parseExplicitPaths(process.argv.slice(2), [
    '--before-database', '--current-database', '--recovery-material-file', '--output',
  ]);
  const result = auditIdentityMigrationFiles({
    beforeDatabasePath: paths['--before-database'], currentDatabasePath: paths['--current-database'],
    recoveryMaterialFile: paths['--recovery-material-file'], outputPath: paths['--output'],
    generatedAt: new Date().toISOString(),
  });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  // Never include native errors, SQL, source evidence, key material or payloads.
  process.stderr.write('Identity migration audit failed.\n');
  process.exitCode = 1;
}
