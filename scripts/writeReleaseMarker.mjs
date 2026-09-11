import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseMarker } from './releaseMarkerContract.cjs';
export { validateReleaseMarker } from './releaseMarkerContract.cjs';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shaPattern = /^[a-f0-9]{40}$/;
const fail = () => { throw new Error('RELEASE_PROVENANCE_FAILED'); };
function git(root, args, run = spawnSync) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = run('git', args, { cwd: root, env, shell: false, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') fail();
  return result.stdout;
}
export function assertCleanHead({ root = projectRoot, expectedSha, run = spawnSync } = {}) {
  const head = git(root, ['rev-parse', '--verify', 'HEAD'], run).trim();
  if (!shaPattern.test(head) || (expectedSha !== undefined && head !== expectedSha)) fail();
  if (git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], run) !== '') fail();
  return head;
}
export function readReleaseMarker({ root = projectRoot } = {}) {
  return validateReleaseMarker(JSON.parse(readFileSync(join(root, 'build/generated/release-marker.json'), 'utf8')));
}
export function writeReleaseMarker({ root = projectRoot, now = () => new Date(), run = spawnSync } = {}) {
  const commitSha = assertCleanHead({ root, run });
  const marker = validateReleaseMarker({ format: 'callie-release', version: 1, commitSha, builtAt: now().toISOString() });
  const directory = join(root, 'build/generated');
  mkdirSync(directory, { recursive: true });
  assertCleanHead({ root, expectedSha: commitSha, run });
  writeFileSync(join(directory, 'release-marker.json'), JSON.stringify(marker) + '\n');
  return marker;
}
export function copyReleaseMarker({ root = projectRoot, buildPath, expectedSha } = {}) {
  const marker = readReleaseMarker({ root });
  if (expectedSha !== undefined && marker.commitSha !== expectedSha) fail();
  assertCleanHead({ root, expectedSha: marker.commitSha });
  writeFileSync(join(buildPath, 'release-marker.json'), JSON.stringify(marker) + '\n', { flag: 'wx' });
  return marker;
}
/** One closure per Forge invocation retains the original build, never a later marker. */
export function createReleaseAssembly({ root = projectRoot } = {}) {
  let original;
  const check = () => {
    if (!original) fail();
    const marker = readReleaseMarker({ root });
    if (marker.commitSha !== original.commitSha || marker.builtAt !== original.builtAt) fail();
    assertCleanHead({ root, expectedSha: original.commitSha });
  };
  return {
    begin() {
      original = readReleaseMarker({ root });
      check();
      // Forge Vite also cleans its baseDir before building. Never graft a marker
      // onto a previous JS bundle, even if a future plugin changes that behavior.
      if (git(root, ['ls-files', '-z', '--', '.vite']) !== '') fail();
      rmSync(join(root, '.vite'), { recursive: true, force: true });
    },
    copy(buildPath) { check(); return copyReleaseMarker({ root, buildPath, expectedSha: original.commitSha }); },
    finish() { check(); },
  };
}
export function verifyReleaseRef({ root = projectRoot, auditedSha, tag, githubSha, githubRef, run = spawnSync }) {
  if (!shaPattern.test(auditedSha) || githubSha !== auditedSha || typeof tag !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(tag) || githubRef !== `refs/tags/${tag}`) fail();
  git(root, ['check-ref-format', `refs/tags/${tag}`], run);
  if (git(root, ['rev-parse', '--is-shallow-repository'], run).trim() !== 'false') fail();
  if (git(root, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], run).trim() !== auditedSha) fail();
  assertCleanHead({ root, expectedSha: auditedSha, run });
  git(root, ['merge-base', '--is-ancestor', auditedSha, 'refs/remotes/origin/main'], run);
  return auditedSha;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--verify-ref') {
      console.log(verifyReleaseRef({ auditedSha: process.env.AUDITED_SHA, tag: process.env.RELEASE_TAG, githubSha: process.env.GITHUB_SHA, githubRef: process.env.GITHUB_REF }));
    } else {
      if (process.argv.length !== 2) fail();
      console.log(JSON.stringify(writeReleaseMarker()));
    }
  } catch { console.error('RELEASE_PROVENANCE_FAILED'); process.exitCode = 1; }
}
