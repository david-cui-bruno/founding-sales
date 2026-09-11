import { finished } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createPackage } from '@electron/asar';
import { scanWithGitleaks, stagePackage, verifySecrets } from '../scripts/verifySecrets.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
async function fixture({ behavior = 'clean', shallow = false } = {}) {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'secret-wrapper-')); roots.push(root);
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'src'));
  for (const name of ['verifySecrets.mjs', 'verifyPackage.mjs', 'verifyAppleBridgePackage.mjs', 'writeReleaseMarker.mjs', 'releaseMarkerContract.cjs']) cpSync(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
  writeFileSync(join(root, 'src/code.ts'), 'export const clean = 1;');
  mkdirSync(join(root, '.vite/build'), { recursive: true }); writeFileSync(join(root, '.vite/build/main.js'), 'generated-sentinel');
  mkdirSync(join(root, '.superpowers')); writeFileSync(join(root, '.superpowers/private'), 'NEVER-COPY');
  writeFileSync(join(root, 'bin/git'), `#!${process.execPath}\nconst a=process.argv.slice(2);process.stdout.write(a.includes('--is-shallow-repository')?${JSON.stringify(shallow ? 'true\n' : 'false\n')}:${JSON.stringify('src/code.ts\0.gitleaks.toml\0')});`);
  writeFileSync(join(root, 'bin/gitleaks'), `#!${process.execPath}\nconst fs=require('fs'),p=require('path'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(join(root, 'calls'))},JSON.stringify(a)+'\\n');if(a[0]==='version'){console.log(${JSON.stringify(behavior === 'wrong-version' ? '8.29.0' : '8.30.1')});process.exit(0);}console.error('SYNTHETIC-RAW-SECRET');if(${JSON.stringify(behavior)}==='signal')process.kill(process.pid,'SIGTERM');const report=a[a.indexOf('--report-path')+1];const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p.join(d,e.name)):p.join(d,e.name));if(a[0]==='dir')fs.appendFileSync(${JSON.stringify(join(root, 'coverage'))},JSON.stringify(walk(a.at(-1)).map(f=>p.relative(a.at(-1),f)))+'\\n');fs.writeFileSync(report,${JSON.stringify(behavior === 'malformed' ? '{}' : behavior === 'finding' ? '[{"RuleID":"synthetic-rule","Secret":"REDACTED","Match":"REDACTED"}]' : '[]')});process.exit(${behavior === 'finding' ? 1 : behavior === 'error' ? 2 : 0});`);
  chmodSync(join(root, 'bin/git'), 0o755); chmodSync(join(root, 'bin/gitleaks'), 0o755);
  const resources = join(root, 'out/Callie.app/Contents/Resources'); mkdirSync(resources, { recursive: true });
  const input = join(root, 'archive-input'); mkdirSync(input); writeFileSync(join(input, 'inside.js'), 'archive-sentinel');
  await finished(await createPackage(input, join(resources, 'app.asar')));
  mkdirSync(join(resources, 'app.asar.unpacked')); writeFileSync(join(resources, 'app.asar.unpacked/native.node'), 'unpacked-sentinel');
  const helpers = join(root, 'out/Callie.app/Contents/Helpers'); mkdirSync(helpers); writeFileSync(join(helpers, 'helper'), 'helper-sentinel');
  return { root, run: (...args) => spawnSync(process.execPath, ['scripts/verifySecrets.mjs', ...args], { cwd: root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` }, encoding: 'utf8' }) };
}
it('uses full fetched history, no inline ignores, full redaction and distinct source/build coverage', async () => {
  const { root, run } = await fixture(); const result = run(); expect(result.status).toBe(0); expect(result.stderr + result.stdout).not.toContain('SYNTHETIC-RAW-SECRET');
  const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(calls.map(a => a[0])).toEqual(['version', 'git', 'dir']);
  expect(calls[1]).toContain('--log-opts=--all --full-history -m');
  for (const args of calls.slice(1)) { expect(args).toContain('--redact=100'); expect(args).toContain('--ignore-gitleaks-allow'); expect(existsSync(args[args.indexOf('--report-path') + 1])).toBe(false); }
  const coverage = JSON.parse(readFileSync(join(root, 'coverage'), 'utf8'));
  expect(coverage).toContain('src/code.ts'); expect(coverage).toContain('.vite/build/main.js'); expect(coverage.some(f => /node_modules|superpowers|out\//.test(f))).toBe(false);
});
it('extracts real ASAR plus actual unpacked/helper content for the separate package scan', async () => {
  const { root, run } = await fixture(); expect(run('--package').status).toBe(0);
  const coverage = JSON.parse(readFileSync(join(root, 'coverage'), 'utf8'));
  expect(coverage).toContain('asar/inside.js'); expect(coverage).toContain('bundle/Contents/Resources/app.asar.unpacked/native.node'); expect(coverage).toContain('bundle/Contents/Helpers/helper');
});
it.each(['wrong-version', 'finding', 'malformed', 'error', 'signal'])('fails closed without raw output: %s', async behavior => { const { run } = await fixture({ behavior }); const result = run(); expect(result.status).not.toBe(0); expect(result.stderr + result.stdout).not.toContain('SYNTHETIC-RAW-SECRET'); });
it('refuses shallow history and missing final packages', async () => { const { root, run } = await fixture({ shallow: true }); expect(run().status).not.toBe(0); rmSync(join(root, 'out'), { recursive: true }); expect(run('--package').status).not.toBe(0); });
it('rejects a missing scanner without a fallback', async () => {
  const { root } = await fixture(); let calls = 0;
  expect(() => verifySecrets({ root, run: () => { calls++; return { error: new Error('PRIVATE-MISSING'), status: null }; } })).toThrow('SECRET_VERIFICATION_FAILED');
  expect(calls).toBe(1);
});
it.each([
  ['wrong-version', false, false, 'scanner-version'],
  ['clean', true, false, 'history-readiness'],
  ['error', false, false, 'history-scan'],
  ['clean', false, true, 'context-staging'],
])('reports only a fixed safe phase for %s / shallow=%s / missing=%s', async (behavior, shallow, missing, phase) => {
  const { root, run } = await fixture({ behavior, shallow });
  if (missing) rmSync(join(root, 'src/code.ts'));
  const result = run();
  expect(result.status).not.toBe(0);
  expect(JSON.parse(result.stderr)).toEqual({ error: 'SECRET_VERIFICATION_FAILED', phase, ...(shallow ? { reason: 'shallow-history' } : {}) });
  expect(result.stderr + result.stdout).not.toContain('SYNTHETIC-RAW-SECRET');
  expect(result.stderr + result.stdout).not.toContain(root);
});
it.each([
  [{ status: 128, stderr: 'fatal: not a git repository: SYNTHETIC-RAW-SECRET' }, 'repository-unavailable'],
  [{ status: 128, stderr: 'fatal: detected dubious ownership in SYNTHETIC-RAW-SECRET' }, 'unsafe-ownership'],
  [{ status: 128, stderr: 'SYNTHETIC-RAW-SECRET' }, 'git-command-failed'],
  [{ status: 0, stdout: 'SYNTHETIC-RAW-SECRET' }, 'unexpected-history-response'],
  [{ status: null, error: { code: 'ENOENT', message: 'SYNTHETIC-RAW-SECRET' } }, 'git-unavailable'],
  [{ status: null, signal: 'SIGTERM' }, 'git-interrupted'],
])('classifies Git preflight failure without copying raw output: %s', async (gitResult, reason) => {
  const { root } = await fixture();
  const calls = [];
  try {
    verifySecrets({ root, run: (command, args) => {
      calls.push([command, args]);
      return command === 'gitleaks' ? { status: 0, stdout: '8.30.1\n' } : gitResult;
    } });
    expect.unreachable('Git preflight must fail before scanning');
  } catch (error) {
    expect(error).toMatchObject({ message: 'SECRET_VERIFICATION_FAILED', phase: 'history-readiness', reason });
    expect(JSON.stringify(error)).not.toContain('SYNTHETIC-RAW-SECRET');
  }
  expect(calls).toEqual([['gitleaks', ['version']], ['git', ['rev-parse', '--is-shallow-repository']]]);
});
it.each(['timeout', 'parent-signal', 'empty-success-report', 'findings-with-zero', 'clean-with-one'])('rejects scanner protocol failure: %s', async mode => {
  const { root } = await fixture(); const temporary = join(root, 'reports'); mkdirSync(temporary, { mode: 0o700 });
  const run = (_command, args) => {
    writeFileSync(args[args.indexOf('--report-path') + 1], mode === 'empty-success-report' ? '' : mode === 'findings-with-zero' ? '[{"RuleID":"synthetic"}]' : '[]');
    return {
      status: mode === 'clean-with-one' ? 1 : 0,
      ...(mode === 'timeout' ? { error: Object.assign(new Error('PRIVATE-TIMEOUT'), { code: 'ETIMEDOUT' }) } : {}),
      ...(mode === 'parent-signal' ? { signal: 'SIGTERM' } : {}),
    };
  };
  const checked = expect(() => scanWithGitleaks({ root, target: root, kind: 'context', temporary, run }));
  if (mode === 'timeout' || mode === 'parent-signal') checked.toThrowError(new Error('SECRET_VERIFICATION_FAILED'));
  else checked.toThrow();
});
it.each(['history', 'context', 'package'])('keeps %s command roots separate from absolute configuration and private reports', kind => {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'scan-cwd-')); roots.push(root);
  const stage = join(root, 'staged input'), temporary = join(root, 'reports');
  mkdirSync(stage, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    writeFileSync(args[args.indexOf('--report-path') + 1], '[]');
    return { status: 0 };
  };
  expect(scanWithGitleaks({ root, target: kind === 'history' ? root : stage, kind, temporary, run }).status).toBe('passed');
  expect(calls).toHaveLength(1);
  const { command, args, options } = calls[0];
  expect(command).toBe('gitleaks');
  expect(options.cwd).toBe(kind === 'history' ? root : realpathSync(stage));
  expect(args.at(-1)).toBe(kind === 'history' ? root : '.');
  expect(args[0]).toBe(kind === 'history' ? 'git' : 'dir');
  expect(args.includes('--log-opts=--all --full-history -m')).toBe(kind === 'history');
  expect(args[args.indexOf('--config') + 1]).toBe(join(root, '.gitleaks.toml'));
  expect(args[args.indexOf('--report-path') + 1]).toBe(join(temporary, `${kind}.json`));
  expect(args[args.indexOf('--gitleaks-ignore-path') + 1]).toBe(join(temporary, 'empty-ignore'));
  expect(args).toContain('--redact=100'); expect(args).toContain('--ignore-gitleaks-allow');
  expect(args.filter(arg => arg === '--timeout')).toHaveLength(1);
  expect(args[args.indexOf('--timeout') + 1]).toBe('0');
  expect(options.timeout).toBe(660_000);
  expect(options.shell).toBe(false);
});
it.each(['symlink', 'file', 'nonprivate'])('rejects a %s directory scan target before invoking the scanner', kind => {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'scan-unsafe-cwd-')); roots.push(root);
  const target = join(root, 'target'), temporary = join(root, 'reports');
  mkdirSync(temporary, { mode: 0o700 });
  if (kind === 'symlink') symlinkSync(temporary, target);
  else if (kind === 'file') writeFileSync(target, 'synthetic');
  else { mkdirSync(target, { mode: 0o700 }); chmodSync(target, 0o755); }
  let calls = 0;
  const run = (_command, args) => { calls++; writeFileSync(args[args.indexOf('--report-path') + 1], '[]'); return { status: 0 }; };
  expect(() => scanWithGitleaks({ root, target, kind: 'context', temporary, run })).toThrow('SECRET_VERIFICATION_FAILED');
  expect(calls).toBe(0);
});

it('scans an explicit candidate without falling back to the canonical output', async () => {
  const { root, run } = await fixture();
  const candidate = join(root, 'candidate');
  cpSync(join(root, 'out'), candidate, { recursive: true });
  writeFileSync(join(root, 'out/Callie.app/Contents/Helpers/canonical-only'), 'not candidate');
  expect(run('--package', candidate).status).toBe(0);
  const coverage = JSON.parse(readFileSync(join(root, 'coverage'), 'utf8'));
  expect(coverage).toContain('asar/inside.js');
  expect(coverage).not.toContain('bundle/Contents/Helpers/canonical-only');
  const stage = join(root, 'stage'); mkdirSync(stage, { mode: 0o700 });
  expect(stagePackage(root, stage, candidate)).toBeGreaterThan(0);
  expect(() => stagePackage(root, stage, join(root, 'missing'))).toThrow();
});
