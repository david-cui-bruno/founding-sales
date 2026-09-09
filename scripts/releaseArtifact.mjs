import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, uncache } from '@electron/asar';
import { validateReleaseMarker } from './writeReleaseMarker.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productName = 'Callie Founder Sales System';
const fail = () => { throw new Error('RELEASE_ARTIFACT_MISMATCH'); };

/** Resolve once in the release runner, then scope every child to this output. */
export function resolveReleaseArtifact({ root = projectRoot, env = process.env } = {}) {
  const outDirectory = resolve(root, env.CALLIE_RELEASE_OUT_DIR || 'out');
  if (env.CALLIE_E2E_OUT_DIR && resolve(root, env.CALLIE_E2E_OUT_DIR) !== outDirectory) fail();
  const appPath = join(outDirectory, `${productName}-darwin-arm64`, `${productName}.app`);
  return { outDirectory, appPath, asarPath: join(appPath, 'Contents/Resources/app.asar'), executable: join(appPath, 'Contents/MacOS', productName) };
}

export function readArtifactIdentity(appPath) {
  appPath = resolve(appPath);
  const asarPath = join(appPath, 'Contents/Resources/app.asar');
  // ASAR caches headers by path. Re-read after each stage, including replacement.
  uncache(asarPath);
  const marker = validateReleaseMarker(JSON.parse(extractFile(asarPath, 'release-marker.json').toString('utf8')));
  return { appPath, commitSha: marker.commitSha, builtAt: marker.builtAt, asarSha256: createHash('sha256').update(readFileSync(asarPath)).digest('hex') };
}

export function assertArtifactIdentity(executable, expectedIdentity) {
  if (!expectedIdentity || typeof expectedIdentity.appPath !== 'string') fail();
  const expectedExecutable = join(expectedIdentity.appPath, 'Contents/MacOS', productName);
  if (resolve(executable) !== expectedExecutable
    || realpathSync(executable) !== join(realpathSync(expectedIdentity.appPath), 'Contents/MacOS', productName)) fail();
  const actual = readArtifactIdentity(expectedIdentity.appPath);
  if (['appPath', 'commitSha', 'builtAt', 'asarSha256'].some(field => actual[field] !== expectedIdentity[field])) fail();
  return actual;
}
