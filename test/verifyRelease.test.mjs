import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPackage, uncacheAll } from '@electron/asar';
import { afterEach, expect, it } from 'vitest';
import { resolveReleaseArtifact, readArtifactIdentity } from '../scripts/releaseArtifact.mjs';
import { verifyRelease } from '../scripts/verifyRelease.mjs';
const roots = [];
it('includes real all-route and modal consumers in the maintained serial browser stage', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(manifest.scripts['test:browser:native-desk'].split(/\s+/)).toEqual([
    'playwright', 'test', '--workers=1',
    'tests/browser/nativeDesk.spec.ts', 'tests/browser/nativeDeskComposition.spec.ts',
    'tests/browser/startupPresentation.spec.ts', 'tests/browser/applicationPresentation.spec.ts',
    'tests/browser/applicationModals.spec.ts',
  ]);
});
afterEach(() => { uncacheAll(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const commands = [
  ['npm', ['run', 'typecheck']], ['npm', ['run', 'lint:tracked']], ['npm', ['run', 'test']],
  ['npm', ['run', 'test:browser:native-desk']], ['npm', ['run', 'test:swift']],
  ['npm', ['run', 'test:helpers:node']], ['npm', ['run', 'test:backup:electron']],
  ['npm', ['run', 'verify:lambdas']], ['npm', ['run', 'package']],
  ['node', ['scripts/verifyPackage.mjs', 'OUT']], ['npm', ['run', 'verify:secrets']],
  ['node', ['scripts/verifySecrets.mjs', '--package', 'OUT']], ['npm', ['run', 'test:e2e']],
  ['node', ['scripts/verifyPackage.mjs', 'OUT']],
];
async function fixture(candidate = 'candidate') {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'release-runner-')); roots.push(root);
  const env = candidate ? { CALLIE_RELEASE_OUT_DIR: candidate } : {};
  const selected = resolveReleaseArtifact({ root, env });
  const marker = { format: 'callie-release', version: 1, commitSha: 'a'.repeat(40), builtAt: '2026-09-09T00:00:00.000Z' };
  const input = join(root, 'input'); mkdirSync(input);
  writeFileSync(join(input, 'release-marker.json'), JSON.stringify(marker));
  mkdirSync(join(root, 'build/generated'), { recursive: true }); writeFileSync(join(root, 'build/generated/release-marker.json'), JSON.stringify(marker));
  mkdirSync(dirname(selected.asarPath), { recursive: true });
  mkdirSync(dirname(selected.executable), { recursive: true }); writeFileSync(selected.executable, 'fixture', { mode: 0o700 });
  await createPackage(input, selected.asarPath);
  return { root, env, selected, marker };
}
function recorder({ failure = 0, afterStage = () => {}, dirty = false, head = 'a'.repeat(40) } = {}) {
  const calls = [], git = [];
  const run = (command, args, options) => {
    if (command === 'git') { git.push(args); return { status: 0, stdout: args[0] === 'rev-parse' ? head + '\n' : dirty ? ' M file\0' : '' }; }
    calls.push({ command, args, options }); afterStage(calls.length);
    return { status: calls.length === failure ? 1 : 0 };
  };
  return { calls, git, run };
}
it.each(['candidate', ''])('owns all serial lanes and the exact %s artifact with E2E-only identity metadata', async candidate => {
  const f = await fixture(candidate), r = recorder();
  const env = { ...f.env, CALLIE_TEST_SYNTHETIC_ELECTRON: '1', CALLIE_E2E_EXPECTED_ARTIFACT: 'untrusted' };
  const before = { ...env };
  expect(verifyRelease({ root: f.root, env, run: r.run })).toEqual(readArtifactIdentity(f.selected.appPath));
  expect(env).toEqual(before);
  expect(r.calls.map(c => [c.command === process.execPath ? 'node' : c.command, c.args])).toEqual(commands.map(([cmd, args]) => [cmd, args.map(a => a === 'OUT' ? f.selected.outDirectory : a)]));
  for (const call of r.calls) {
    expect(call.options.cwd).toBe(f.root); expect(call.options.shell).toBe(false);
    expect(call.options.env.CALLIE_RELEASE_OUT_DIR).toBe(f.selected.outDirectory);
    expect(call.options.env.CALLIE_E2E_OUT_DIR).toBe(f.selected.outDirectory);
    expect(call.options.env.CALLIE_TEST_SYNTHETIC_ELECTRON).toBeUndefined();
    if (call.args.includes('test:e2e')) expect(JSON.parse(call.options.env.CALLIE_E2E_EXPECTED_ARTIFACT)).toEqual(readArtifactIdentity(f.selected.appPath));
    else expect(call.options.env.CALLIE_E2E_EXPECTED_ARTIFACT).toBeUndefined();
  }
  expect(r.git.filter(args => args[0] === 'status')).toHaveLength(2);
});
it.each(commands.map((_, i) => i + 1))('short-circuits failed serial stage %i', async failure => {
  const f = await fixture(), r = recorder({ failure });
  expect(() => verifyRelease({ root: f.root, env: f.env, run: r.run })).toThrow();
  expect(r.calls).toHaveLength(failure);
});
it('rejects conflicting selection before requesting any process', async () => {
  const f = await fixture(), r = recorder();
  expect(() => verifyRelease({ root: f.root, env: { ...f.env, CALLIE_E2E_OUT_DIR: 'other' }, run: r.run })).toThrow();
  expect(r.calls).toEqual([]); expect(r.git).toEqual([]);
});
it('rejects dirty HEAD before builds and package mutation after E2E', async () => {
  const f = await fixture(), dirty = recorder({ dirty: true });
  expect(() => verifyRelease({ root: f.root, env: f.env, run: dirty.run })).toThrow(); expect(dirty.calls).toEqual([]);
  const r = recorder({ afterStage: stage => { if (stage === 13) writeFileSync(f.selected.asarPath, Buffer.concat([readFileSync(f.selected.asarPath), Buffer.from('changed')])); } });
  expect(() => verifyRelease({ root: f.root, env: f.env, run: r.run })).toThrow();
});
it.each(['error', 'signal'])('short-circuits subprocess %s even with a zero status', async mode => {
  const f = await fixture(), r = recorder();
  const run = (command, args, options) => {
    const result = r.run(command, args, options);
    return command === 'git' ? result : { ...result, [mode]: mode === 'error' ? new Error('failed spawn') : 'SIGTERM' };
  };
  expect(() => verifyRelease({ root: f.root, env: f.env, run })).toThrow();
  expect(r.calls).toHaveLength(1);
});
it.each(['commitSha', 'builtAt'])('rejects a package whose %s differs from the build marker before scans/E2E', async field => {
  const f = await fixture(), r = recorder();
  writeFileSync(join(f.root, 'build/generated/release-marker.json'), JSON.stringify({ ...f.marker, [field]: field === 'commitSha' ? 'b'.repeat(40) : '2026-09-09T01:00:00.000Z' }));
  expect(() => verifyRelease({ root: f.root, env: f.env, run: r.run })).toThrow('RELEASE_ARTIFACT_MISMATCH');
  expect(r.calls).toHaveLength(10);
});
it.each(['head', 'dirty'])('rejects final %s changes after otherwise successful stages', async mode => {
  const f = await fixture(), r = recorder();
  const run = (command, args, options) => {
    const result = r.run(command, args, options);
    if (command === 'git' && r.calls.length === commands.length) {
      if (mode === 'head' && args[0] === 'rev-parse') return { status: 0, stdout: 'b'.repeat(40) + '\n' };
      if (mode === 'dirty' && args[0] === 'status') return { status: 0, stdout: ' M changed\0' };
    }
    return result;
  };
  expect(() => verifyRelease({ root: f.root, env: f.env, run })).toThrow();
  expect(r.calls).toHaveLength(commands.length);
});
