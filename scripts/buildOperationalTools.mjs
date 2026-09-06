import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

// Reuse the installed Vite toolchain. No additional production dependency.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Set([
  'src/main/db/readOnlyEncryptedDatabase.ts', 'src/main/db/sqliteDriver.ts',
  'src/main/db/sqliteDriverDecision.ts', 'src/main/security/recoveryKey.ts',
  'src/main/domain/source/cloudNameMatching.ts',
  'src/main/identityMigration/identityMigrationAudit.ts',
  'src/main/identityMigration/identityMigrationManifest.ts',
]);
const result = await build({
  absWorkingDir: root,
  entryPoints: {
    identityMigrationAudit: 'src/main/identityMigration/identityMigrationAudit.ts',
    identityMigrationManifest: 'src/main/identityMigration/identityMigrationManifest.ts',
    readOnlyEncryptedDatabase: 'src/main/db/readOnlyEncryptedDatabase.ts',
  },
  outdir: 'build/generated/operational-tools', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  packages: 'external', metafile: true, write: false, logLevel: 'silent',
});
const inputs = Object.keys(result.metafile.inputs).sort();
if (inputs.some(path => !allowed.has(path))) throw new Error('Operational tools imported an unapproved module.');
// Publish build artifacts only after the complete dependency graph is checked.
await mkdir(resolve(root, 'build/generated/operational-tools'), { recursive: true });
for (const output of result.outputFiles) await writeFile(output.path, output.contents);
await writeFile(resolve(root, 'build/generated/operational-tools/inputs.json'), JSON.stringify(inputs, null, 2) + '\n');

// Writable backup composition is deliberately NOT part of the seven-module
// read-only identity audit graph above. Check it independently before publishing.
const preReleaseAllowed = new Set([
  'src/main/applicationPaths.ts',
  'src/main/backup/preReleaseBackupRuntime.ts', 'src/main/backup/backupService.ts',
  'src/main/backup/backupRetention.ts', 'src/main/backup/verifiedBackup.ts',
  'src/main/db/database.ts', 'src/main/db/databaseEncryption.ts',
  'src/main/db/sqliteDriver.ts', 'src/main/db/sqliteDriverDecision.ts',
  'src/main/domain/startup/storageReadiness.ts', 'src/main/domain/startup/domainStartupTypes.ts',
  'src/main/domain/operations/operationalSafetyRepository.ts',
  'src/main/domain/support/domainUnitOfWork.ts', 'src/main/domain/support/domainErrors.ts',
  'src/main/domain/support/clock.ts', 'src/main/domain/support/idGenerator.ts',
  'src/main/security/workspaceKeyStore.ts', 'src/main/security/safeStorageKeyProtector.ts',
  'src/main/security/keyProtector.ts', 'src/main/security/recoveryKey.ts',
]);
const backup = await build({
  absWorkingDir: root,
  entryPoints: { preReleaseBackupRuntime: 'src/main/backup/preReleaseBackupRuntime.ts' },
  outdir: 'build/generated/pre-release-tools', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  packages: 'external', metafile: true, write: false, logLevel: 'silent',
});
const backupInputs = Object.keys(backup.metafile.inputs).sort();
const externalImports = [...new Set(Object.values(backup.metafile.outputs).flatMap(output => output.imports.filter(entry => entry.external).map(entry => entry.path)))].sort();
if (backupInputs.some(path => !preReleaseAllowed.has(path))
  || externalImports.some(path => !path.startsWith('node:') && !['kysely', 'zod', 'better-sqlite3-multiple-ciphers', 'better-sqlite3-multiple-ciphers/package.json'].includes(path))) {
  throw new Error('Pre-release backup tools imported an unapproved module.');
}
await mkdir(resolve(root, 'build/generated/pre-release-tools'), { recursive: true });
for (const output of backup.outputFiles) await writeFile(output.path, output.contents);
await writeFile(resolve(root, 'build/generated/pre-release-tools/inputs.json'), JSON.stringify(backupInputs, null, 2) + '\n');
await writeFile(resolve(root, 'build/generated/pre-release-tools/imports.json'), JSON.stringify(externalImports, null, 2) + '\n');
