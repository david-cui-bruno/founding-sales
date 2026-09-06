import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const retained = [];
try {
  const { openPrivateInput, parseExplicitPaths, sha256, writePrivateManifest } = require('../build/generated/operational-tools/readOnlyEncryptedDatabase.cjs');
  const { finalizeIdentityMigrationReview, serializeIdentityMigrationManifest } = require('../build/generated/operational-tools/identityMigrationManifest.cjs');
  const paths = parseExplicitPaths(process.argv.slice(2), ['--audit-manifest', '--decisions', '--output']);
  const audit = openPrivateInput(paths['--audit-manifest']); retained.push(audit);
  const decisions = openPrivateInput(paths['--decisions']); retained.push(decisions);
  const manifest = finalizeIdentityMigrationReview({
    auditManifestBytes: audit.bytes, decisions: JSON.parse(decisions.bytes.toString('utf8')),
    reviewedAt: new Date().toISOString(),
  });
  for (const input of retained) input.assertUnchanged();
  const content = serializeIdentityMigrationManifest(manifest);
  writePrivateManifest(paths['--output'], content);
  process.stdout.write(JSON.stringify({ count: manifest.candidates.length, sha256: sha256(content), path: paths['--output'] }) + '\n');
} catch {
  process.stderr.write('Identity migration review failed.\n');
  process.exitCode = 1;
} finally {
  for (const input of retained) input.close();
}
