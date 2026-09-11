import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const names = ['shared', 'adapter-boston-assessments', 'adapter-boston-rentsmart', 'adapter-pvd-taxroll', 'enricher', 'mail-parse', 'resolver', 'schedule-watchdog', 'scorer', 'suppression-sync', 'new-package'];
function fixture({ fail = '', missing = false } = {}) {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'lambda-verifier-')); roots.push(root);
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'));
  cpSync(new URL('../scripts/verifyLambdas.mjs', import.meta.url), join(root, 'scripts/verifyLambdas.mjs'));
  for (const name of names) {
    mkdirSync(join(root, 'cloud/lambdas', name), { recursive: true });
    writeFileSync(join(root, 'cloud/lambdas', name, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest', ...(name !== 'shared' && !(missing && name === 'resolver') ? { build: 'node build.mjs' } : {}) } }));
  }
  writeFileSync(join(root, 'bin/git'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(names.map(name => `cloud/lambdas/${name}/package.json`).join('\0') + '\0')});`);
  writeFileSync(join(root, 'bin/npm'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(root, 'calls'))}, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');process.exit(process.argv[3]===${JSON.stringify(fail)}?2:0);`);
  for (const file of ['git', 'npm']) chmodSync(join(root, 'bin', file), 0o755);
  return { root, run: () => spawnSync(process.execPath, ['scripts/verifyLambdas.mjs'], { cwd: root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` }, encoding: 'utf8' }) };
}
it('discovers all ten packages plus additions and runs shared first without build', () => {
  const { root, run } = fixture(); expect(run().status).toBe(0);
  const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(calls).toEqual(['shared', ...names.filter(name => name !== 'shared').sort()].flatMap(name => (name === 'shared' ? ['typecheck', 'test'] : ['typecheck', 'test', 'build']).map(phase => ({ cwd: join(root, 'cloud/lambdas', name), args: ['run', phase] }))));
});
it('rejects incomplete scripts before executing any package', () => { const { root, run } = fixture({ missing: true }); expect(run().status).not.toBe(0); expect(() => readFileSync(join(root, 'calls'))).toThrow(); });
it.each(['typecheck', 'test', 'build'])('stops on failing %s without installing', fail => {
  const { root, run } = fixture({ fail }); expect(run().status).not.toBe(0);
  const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(calls.at(-1).args).toEqual(['run', fail]); expect(calls.every(call => call.args[0] === 'run')).toBe(true);
});
