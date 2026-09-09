import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createPackage } from '@electron/asar';
import { afterEach, expect, it } from 'vitest';
import { writeReleaseMarker } from '../scripts/writeReleaseMarker.mjs';
import { validatePreReleaseReceipt } from '../scripts/createPreReleaseBackup.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const receipt = { basename: 'pre_release-20260906T170000000Z.sqlite3', kind: 'pre_release', schemaVersion: 24, sha256: 'a'.repeat(64), sizeBytes: 100, createdAt: '2026-09-06T17:00:00.000Z', verifiedAt: '2026-09-06T17:00:00.000Z' };
it('accepts exactly seven public fields in a current24 launcher receipt', () => { expect(validatePreReleaseReceipt(receipt)).toEqual(receipt); });
it.each([
  ['schemaVersion', 14], ['schemaVersion', 15], ['schemaVersion', 16], ['schemaVersion', 17], ['schemaVersion', 18], ['schemaVersion', 23], ['schemaVersion', 25], ['schemaVersion', '24'], ['schemaVersion', null], ['schemaVersion', true],
  ['basename', [receipt.basename]], ['basename', 'private/path.sqlite3'], ['kind', 'manual'],
  ['sha256', [receipt.sha256]], ['sha256', 'A'.repeat(64)], ['sizeBytes', '100'], ['sizeBytes', 0], ['sizeBytes', 1.5],
  ['createdAt', [receipt.createdAt]], ['createdAt', '2026-09-06'], ['verifiedAt', null], ['verifiedAt', 'invalid'], ['path', '/private'],
])('rejects malformed launcher receipt field %s=%j', (field, value) => {
  expect(() => validatePreReleaseReceipt({ ...receipt, [field]: value })).toThrow('PRE_RELEASE_BACKUP_FAILED');
});
it.each(['basename', 'createdAt', 'kind', 'schemaVersion', 'sha256', 'sizeBytes', 'verifiedAt'])('rejects a launcher receipt missing %s', field => {
  const missing = { ...receipt }; delete missing[field]; expect(() => validatePreReleaseReceipt(missing)).toThrow('PRE_RELEASE_BACKUP_FAILED');
});
async function fixture({ identity = 'com.callie.foundersales', output = receipt } = {}) {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'backup-launcher-')); roots.push(root); mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'));
  for (const name of ['createPreReleaseBackup.mjs', 'writeReleaseMarker.mjs']) cpSync(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  symlinkSync(resolve('node_modules'), join(root, 'node_modules')); writeFileSync(join(root, '.gitignore'), 'out/\nbuild/generated/\nnode_modules/\narchive/\ncalled\n');
  const product = 'Callie Founder Sales System'; const contents = join(root, 'out', `${product}-darwin-arm64`, `${product}.app/Contents`);
  mkdirSync(join(contents, 'MacOS'), { recursive: true }); mkdirSync(join(contents, 'Resources')); writeFileSync(join(contents, 'Info.plist'), 'fixture');
  const executable = join(contents, 'MacOS', product); writeFileSync(executable, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(join(root, 'called'))},JSON.stringify(process.argv.slice(2)));console.error('PRIVATE-HOST-ERROR');console.log(${JSON.stringify(JSON.stringify(output))});`); chmodSync(executable, 0o755);
  writeFileSync(join(root, 'bin/plutil'), `#!${process.execPath}\nconsole.log(({CFBundleIdentifier:${JSON.stringify(identity)},CFBundleName:${JSON.stringify(product)},CFBundleDisplayName:${JSON.stringify(product)},CFBundleExecutable:${JSON.stringify(product)}})[process.argv[3]]);`); chmodSync(join(root, 'bin/plutil'), 0o755);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  git('init'); git('add', '.'); git('commit', '-m', 'fixture');
  const marker = writeReleaseMarker({ root }); mkdirSync(join(root, 'archive')); writeFileSync(join(root, 'archive/release-marker.json'), JSON.stringify(marker)); await createPackage(join(root, 'archive'), join(contents, 'Resources/app.asar'));
  // This fixture owns a synthetic repo/app. Outer release/test controls must not
  // select its behavior. Explicit negative-case overrides remain last so the
  // unchanged real launcher still rejects every forbidden environment family.
  const launcherEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CALLIE_|ELECTRON_|NODE_|DYLD_|XDG_)/.test(name)));
  return { root, git, contents, run: (args = [], env = {}) => spawnSync(process.execPath, [join(root, 'scripts/createPreReleaseBackup.mjs'), ...args], { cwd: tmpdir(), env: { ...launcherEnv, PATH: `${root}/bin:${process.env.PATH}`, ...env }, encoding: 'utf8' }) };
}
it('launches only exact repo-owned packaged executable with reserved flag and emits receipt alone', async () => {
  const { root, run } = await fixture(); const result = run(); expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual(receipt); expect(result.stderr).not.toContain('PRIVATE-HOST'); expect(JSON.parse(readFileSync(join(root, 'called')))).toEqual(['--callie-pre-release-backup']);
});
it.each([14, 15, 16, 17, 18, 23, 25, '24'])('refuses unsupported host schema %j through the real launcher entrypoint without leaking stdout', async schemaVersion => {
  const { root, run } = await fixture({ output: { ...receipt, schemaVersion } }); const result = run();
  expect(existsSync(join(root, 'called'))).toBe(true); expect(result.status).toBe(1);
  expect(result.stdout).toBe(''); expect(result.stderr.trim()).toBe('PRE_RELEASE_BACKUP_FAILED');
});
it.each([['--database', '/x'], ['--executable', '/x'], ['--user-data-dir=/x'], ['--key', 'x']])('rejects CLI override before launch %j', async (...args) => { const { root, run } = await fixture(); expect(run(args).status).not.toBe(0); expect(existsSync(join(root, 'called'))).toBe(false); });
it.each(['CALLIE_USER_DATA', 'CALLIE_RELEASE_OUT_DIR', 'CALLIE_E2E_OUT_DIR', 'CALLIE_E2E_EXPECTED_ARTIFACT', 'CALLIE_MAC_SIGN_IDENTITY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'DYLD_INSERT_LIBRARIES'])('rejects %s before launch', async name => { const { root, run } = await fixture(); expect(run([], { [name]: name === 'NODE_OPTIONS' ? '--no-warnings' : 'x' }).status).not.toBe(0); expect(existsSync(join(root, 'called'))).toBe(false); });
it('rejects identity mismatch before launch and arbitrary host stdout after launch', async () => { const wrong = await fixture({ identity: 'com.example.other' }); expect(wrong.run().status).not.toBe(0); expect(existsSync(join(wrong.root, 'called'))).toBe(false); const extra = await fixture({ output: { ...receipt, path: '/private' } }); const result = extra.run(); expect(result.status).not.toBe(0); expect(result.stdout + result.stderr).not.toContain('/private'); });
it.each(['dirty', 'new-head', 'missing-marker', 'ambiguous-app', 'missing-executable'])('rejects %s before any host work', async change => {
  const { root, git, contents, run } = await fixture();
  if (change === 'dirty') writeFileSync(join(root, 'untracked.txt'), 'uncommitted');
  if (change === 'new-head') git('commit', '--allow-empty', '-m', 'changed head');
  if (change === 'missing-marker') { rmSync(join(root, 'archive/release-marker.json')); await createPackage(join(root, 'archive'), join(contents, 'Resources/app.asar')); }
  if (change === 'ambiguous-app') mkdirSync(join(contents, '../../Other.app'));
  if (change === 'missing-executable') rmSync(join(contents, 'MacOS/Callie Founder Sales System'));
  const result = run(); expect(result.status).not.toBe(0); expect(existsSync(join(root, 'called'))).toBe(false);
});
