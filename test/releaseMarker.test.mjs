import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { assertCleanHead, copyReleaseMarker, validateReleaseMarker, writeReleaseMarker, verifyReleaseRef, createReleaseAssembly } from '../scripts/writeReleaseMarker.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const now = () => new Date('2026-09-06T17:00:00.000Z');
function fixture() {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'release-marker-')); roots.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
  git('init', '-b', 'main'); writeFileSync(join(root, '.gitignore'), 'build/generated/\n'); mkdirSync(join(root, 'scripts'));
  for (const name of ['writeReleaseMarker.mjs', 'releaseMarkerContract.cjs']) cpSync(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  git('add', '.'); git('commit', '-m', 'fixture');
  return { root, git, sha: git('rev-parse', 'HEAD') };
}
it('writes actual clean HEAD and copies identical validated bytes into assembly', () => {
  const { root, sha } = fixture(); const marker = writeReleaseMarker({ root, now });
  expect(marker).toEqual({ format: 'callie-release', version: 1, commitSha: sha, builtAt: '2026-09-06T17:00:00.000Z' });
  const buildPath = join(root, 'build/generated/assembly'); mkdirSync(buildPath, { recursive: true });
  copyReleaseMarker({ root, buildPath, expectedSha: sha });
  expect(JSON.parse(readFileSync(join(buildPath, 'release-marker.json'), 'utf8'))).toEqual(marker);
});
it.each(['tracked', 'index', 'untracked'])('refuses %s dirt before marker creation and copy', dirt => {
  const { root, git, sha } = fixture(); writeReleaseMarker({ root, now });
  writeFileSync(join(root, dirt === 'untracked' ? 'new.ts' : '.gitignore'), 'changed'); if (dirt === 'index') git('add', '.gitignore');
  expect(() => assertCleanHead({ root })).toThrow(); expect(() => writeReleaseMarker({ root, now })).toThrow();
  expect(() => copyReleaseMarker({ root, buildPath: join(root, 'build/generated'), expectedSha: sha })).toThrow();
});
it('rejects changed HEAD even when clean and an old marker remains', () => {
  const { root, git, sha } = fixture(); writeReleaseMarker({ root, now }); git('commit', '--allow-empty', '-m', 'new head');
  expect(() => assertCleanHead({ root, expectedSha: sha })).toThrow();
  expect(() => copyReleaseMarker({ root, buildPath: join(root, 'build/generated') })).toThrow();
});
it.each([{ version: 2 }, { format: 'other' }, { commitSha: 'f'.repeat(39) }, { commitSha: 'F'.repeat(40) }, { builtAt: '2026-09-06' }, { builtAt: '2026-02-31T00:00:00.000Z' }, { extra: true }])('rejects malformed marker %j', change => {
  expect(() => validateReleaseMarker({ format: 'callie-release', version: 1, commitSha: 'a'.repeat(40), builtAt: now().toISOString(), ...change })).toThrow();
});
it('executes entrypoint and does not accept an environment supplied SHA or CLI override', () => {
  const { root, sha } = fixture();
  expect(spawnSync(process.execPath, ['scripts/writeReleaseMarker.mjs'], { cwd: root, env: { ...process.env, EXPECTED_SHA: 'f'.repeat(40) } }).status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'build/generated/release-marker.json'))).commitSha).toBe(sha);
  expect(spawnSync(process.execPath, ['scripts/writeReleaseMarker.mjs', '--sha', sha], { cwd: root }).status).not.toBe(0);
});
it('requires tag dispatch, exact peeled tag/input/HEAD/GITHUB_SHA and main ancestry', () => {
  const { root, git, sha } = fixture(); git('tag', '-a', 'v-test', '-m', 'tag'); git('update-ref', 'refs/remotes/origin/main', sha);
  const input = { root, auditedSha: sha, tag: 'v-test', githubSha: sha, githubRef: 'refs/tags/v-test' };
  expect(verifyReleaseRef(input)).toBe(sha);
  for (const change of [{ auditedSha: 'f'.repeat(40) }, { githubSha: 'f'.repeat(40) }, { tag: 'missing' }, { githubRef: 'refs/heads/main' }, { tag: '--help' }]) expect(() => verifyReleaseRef({ ...input, ...change })).toThrow();
  git('checkout', '--orphan', 'unrelated'); git('commit', '--allow-empty', '-m', 'unrelated'); const other = git('rev-parse', 'HEAD'); git('tag', 'v-other');
  expect(() => verifyReleaseRef({ root, auditedSha: other, tag: 'v-other', githubSha: other, githubRef: 'refs/tags/v-other' })).toThrow();
});
it('captures original provenance, removes only generated Vite output, and refuses marker replacement', () => {
  const { root, git } = fixture(); writeFileSync(join(root, '.gitignore'), 'build/generated/\n.vite/\n'); git('add', '.'); git('commit', '-m', 'ignore build');
  writeReleaseMarker({ root, now }); mkdirSync(join(root, '.vite')); writeFileSync(join(root, '.vite/stale.js'), 'stale');
  const assembly = createReleaseAssembly({ root }); expect(() => assembly.copy(root)).toThrow(); assembly.begin();
  expect(() => readFileSync(join(root, '.vite/stale.js'))).toThrow();
  const buildPath = join(root, 'build/generated/assembly'); mkdirSync(buildPath); assembly.copy(buildPath); assembly.finish();
  writeReleaseMarker({ root, now: () => new Date('2026-09-06T18:00:00.000Z') });
  expect(() => assembly.copy(buildPath)).toThrow(); expect(() => assembly.finish()).toThrow();
});
