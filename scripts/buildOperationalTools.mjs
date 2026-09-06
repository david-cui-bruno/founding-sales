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
