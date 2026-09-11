import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createPackage, uncacheAll } from '@electron/asar';
import { afterEach, expect, it } from 'vitest';
import { resolveReleaseArtifact, readArtifactIdentity, assertArtifactIdentity } from '../scripts/releaseArtifact.mjs';

const roots = [];
afterEach(() => { uncacheAll(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const fixtureRoot = () => {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'release-identity-'));
  roots.push(root); return root;
};
async function artifact(root, name, marker = { format: 'callie-release', version: 1, commitSha: 'a'.repeat(40), builtAt: '2026-09-09T00:00:00.000Z' }) {
  const selected = resolveReleaseArtifact({ root, env: { CALLIE_RELEASE_OUT_DIR: name } });
  const input = join(root, `${name}-input`);
  mkdirSync(input, { recursive: true, mode: 0o700 });
  writeFileSync(join(input, 'release-marker.json'), JSON.stringify(marker));
  writeFileSync(join(input, 'main.js'), name);
  mkdirSync(dirname(selected.asarPath), { recursive: true });
  mkdirSync(dirname(selected.executable), { recursive: true });
  writeFileSync(selected.executable, 'synthetic binary', { mode: 0o700 });
  await finished(await createPackage(input, selected.asarPath));
  return selected;
}
it('resolves default and relative candidate paths, rejecting a conflicting E2E selection before any IO', () => {
  const root = fixtureRoot();
  expect(resolveReleaseArtifact({ root, env: {} }).outDirectory).toBe(join(root, 'out'));
  expect(resolveReleaseArtifact({ root, env: { CALLIE_RELEASE_OUT_DIR: 'candidate' } }).outDirectory).toBe(join(root, 'candidate'));
  expect(resolveReleaseArtifact({ root, env: { CALLIE_RELEASE_OUT_DIR: 'candidate', CALLIE_E2E_OUT_DIR: join(root, 'candidate') } }).outDirectory).toBe(join(root, 'candidate'));
  expect(() => resolveReleaseArtifact({ root, env: { CALLIE_RELEASE_OUT_DIR: 'a', CALLIE_E2E_OUT_DIR: 'b' } })).toThrow();
  expect(() => resolveReleaseArtifact({ root, env: { CALLIE_E2E_OUT_DIR: 'candidate' } })).toThrow();
});
it('binds actual selected binary path, embedded marker and actual ASAR bytes across two real archives', async () => {
  const root = fixtureRoot();
  const a = await artifact(root, 'a');
  const b = await artifact(root, 'b', { format: 'callie-release', version: 1, commitSha: 'b'.repeat(40), builtAt: '2026-09-09T01:00:00.000Z' });
  const identity = readArtifactIdentity(a.appPath);
  expect(identity).toEqual({ appPath: resolve(a.appPath), commitSha: 'a'.repeat(40), builtAt: '2026-09-09T00:00:00.000Z', asarSha256: createHash('sha256').update(readFileSync(a.asarPath)).digest('hex') });
  expect(() => assertArtifactIdentity(a.executable, identity)).not.toThrow();
  expect(() => assertArtifactIdentity(b.executable, identity)).toThrow();
  for (const field of ['commitSha', 'builtAt', 'asarSha256']) {
    expect(() => assertArtifactIdentity(a.executable, { ...identity, [field]: readArtifactIdentity(b.appPath)[field] })).toThrow();
  }
  expect(() => assertArtifactIdentity(join(dirname(a.executable), 'other'), identity)).toThrow();
  // Replacing the archive at the same path must not reuse ASAR's cached marker.
  writeFileSync(a.asarPath, readFileSync(b.asarPath));
  expect(readArtifactIdentity(a.appPath).commitSha).toBe('b'.repeat(40));
  expect(() => assertArtifactIdentity(a.executable, identity)).toThrow();
});
it('rejects malformed embedded markers rather than trusting metadata', async () => {
  const a = await artifact(fixtureRoot(), 'invalid', { format: 'callie-release', version: 1, commitSha: 'bad', builtAt: 'yesterday' });
  expect(() => readArtifactIdentity(a.appPath)).toThrow();
});
