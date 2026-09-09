const { createHash } = require('node:crypto');
const { readFileSync, realpathSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { extractFile, uncache } = require('@electron/asar');
const { validateReleaseMarker } = require('./releaseMarkerContract.cjs');

// Shared by native ESM scripts and Playwright's CommonJS test loader. This core
// has no CLI branch or transitive import.meta dependency.
const projectRoot = resolve(__dirname, '..');
const productName = 'Callie Founder Sales System';
const fail = () => { throw new Error('RELEASE_ARTIFACT_MISMATCH'); };

function resolveReleaseArtifact({ root = projectRoot, env = process.env } = {}) {
  const outDirectory = resolve(root, env.CALLIE_RELEASE_OUT_DIR || 'out');
  if (env.CALLIE_E2E_OUT_DIR && resolve(root, env.CALLIE_E2E_OUT_DIR) !== outDirectory) fail();
  const appPath = join(outDirectory, `${productName}-darwin-arm64`, `${productName}.app`);
  return { outDirectory, appPath, asarPath: join(appPath, 'Contents/Resources/app.asar'), executable: join(appPath, 'Contents/MacOS', productName) };
}

function readArtifactIdentity(appPath) {
  appPath = resolve(appPath);
  const asarPath = join(appPath, 'Contents/Resources/app.asar');
  // ASAR caches headers by path. Re-read after each stage, including replacement.
  uncache(asarPath);
  const marker = validateReleaseMarker(JSON.parse(extractFile(asarPath, 'release-marker.json').toString('utf8')));
  return { appPath, commitSha: marker.commitSha, builtAt: marker.builtAt, asarSha256: createHash('sha256').update(readFileSync(asarPath)).digest('hex') };
}

function assertArtifactIdentity(executable, expectedIdentity) {
  if (!expectedIdentity || typeof expectedIdentity.appPath !== 'string') fail();
  const expectedExecutable = join(expectedIdentity.appPath, 'Contents/MacOS', productName);
  if (resolve(executable) !== expectedExecutable
    || realpathSync(executable) !== join(realpathSync(expectedIdentity.appPath), 'Contents/MacOS', productName)) fail();
  const actual = readArtifactIdentity(expectedIdentity.appPath);
  if (['appPath', 'commitSha', 'builtAt', 'asarSha256'].some(field => actual[field] !== expectedIdentity[field])) fail();
  return actual;
}
exports.resolveReleaseArtifact = resolveReleaseArtifact;
exports.readArtifactIdentity = readArtifactIdentity;
exports.assertArtifactIdentity = assertArtifactIdentity;
