import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertArtifactIdentity, readArtifactIdentity, resolveReleaseArtifact } from './releaseArtifact.mjs';
import { assertCleanHead, readReleaseMarker } from './writeReleaseMarker.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function verifyRelease({ root = projectRoot, env = process.env, run = spawnSync } = {}) {
  const artifact = resolveReleaseArtifact({ root, env });
  const commitSha = assertCleanHead({ root, run });
  const childEnv = { ...env, CALLIE_RELEASE_OUT_DIR: artifact.outDirectory, CALLIE_E2E_OUT_DIR: artifact.outDirectory };
  // Only the named host command enables its own flag. Never inherit identities.
  delete childEnv.CALLIE_TEST_SYNTHETIC_ELECTRON;
  delete childEnv.CALLIE_E2E_EXPECTED_ARTIFACT;
  const checked = (command, args, scopedEnv = childEnv) => {
    const result = run(command, args, { cwd: root, env: { ...scopedEnv }, shell: false, stdio: 'inherit' });
    if (result.error || result.signal || result.status !== 0) throw new Error(`RELEASE_STAGE_FAILED: ${command} ${args.join(' ')}`);
  };
  const npm = (name, scopedEnv) => checked('npm', ['run', name], scopedEnv);
  for (const stage of ['legacy:typecheck', 'legacy:lint:tracked', 'legacy:test', 'legacy:test:browser:native-desk', 'legacy:test:swift', 'legacy:test:helpers:node', 'legacy:test:backup:electron', 'legacy:verify:lambdas', 'legacy:package']) npm(stage);
  checked(process.execPath, ['scripts/verifyPackage.mjs', artifact.outDirectory]);
  const identity = readArtifactIdentity(artifact.appPath);
  const marker = readReleaseMarker({ root });
  if (identity.commitSha !== commitSha || identity.commitSha !== marker.commitSha || identity.builtAt !== marker.builtAt) throw new Error('RELEASE_ARTIFACT_MISMATCH');
  assertArtifactIdentity(artifact.executable, identity);
  npm('verify:secrets');
  checked(process.execPath, ['scripts/verifySecrets.mjs', '--package', artifact.outDirectory]);
  assertArtifactIdentity(artifact.executable, identity);
  npm('legacy:test:e2e', { ...childEnv, CALLIE_E2E_EXPECTED_ARTIFACT: JSON.stringify(identity) });
  checked(process.execPath, ['scripts/verifyPackage.mjs', artifact.outDirectory]);
  assertArtifactIdentity(artifact.executable, identity);
  assertCleanHead({ root, expectedSha: commitSha, run });
  return identity;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('RELEASE_ARGUMENTS_INVALID');
    console.log(JSON.stringify(verifyRelease()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
