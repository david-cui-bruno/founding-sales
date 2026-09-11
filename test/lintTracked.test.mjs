import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(paths, failure = '') {
  const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'tracked-lint-')); roots.push(root);
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'node_modules/eslint/bin'), { recursive: true });
  cpSync(new URL('../scripts/lintTracked.mjs', import.meta.url), join(root, 'scripts/lintTracked.mjs'));
  writeFileSync(join(root, 'paths.json'), JSON.stringify(paths));
  writeFileSync(join(root, 'bin/git'), `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync('git-args',JSON.stringify(process.argv.slice(2)));process.stdout.write(JSON.parse(fs.readFileSync('paths.json')).join('\\0')+'\\0');process.exit(${failure === 'git' ? 1 : 0});`);
  chmodSync(join(root, 'bin/git'), 0o755);
  writeFileSync(join(root, 'node_modules/eslint/bin/eslint.js'), `const fs=require('fs');fs.appendFileSync('calls', JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');process.exit(${failure === 'lint' ? 2 : 0});`);
  return { root, run: () => spawnSync(process.execPath, ['scripts/lintTracked.mjs'], { cwd: root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` }, encoding: 'utf8' }) };
}
it('executes only supported tracked sources without ignores, with literal bounded argv', () => {
  const sources = ['cloud/lambdas/resolver/src/a.ts', 'a space.ts', 'line\nbreak.mjs', '-option.cts', 'config.mts', 'view.tsx', 'script.cjs', ...Array.from({ length: 230 }, (_, i) => `src/${i}.js`)];
  const { root, run } = fixture([...sources, 'x/node_modules/a.js', 'node_modules/a.js', 'cloud/lambdas/a/dist/index.js', '.vite/x.js', 'out/x.js', 'build/generated/x.js', 'native/safe-log-fs/build/x.js', 'native/apple-bridge/.build/x.js', 'coverage/x.js', 'test-results/x.js', 'a.json', 'a.yml', 'a.tf']);
  expect(run().status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'git-args'), 'utf8'))).toEqual(['ls-files', '-z']);
  const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.flatMap(call => { expect(call.cwd).toBe(root); expect(call.args.slice(0, 4)).toEqual(['--no-ignore', '--max-warnings', '0', '--']); return call.args.slice(4); })).toEqual(sources.sort());
});
it.each(['git', 'lint'])('fails closed on %s command failure', failure => { expect(fixture(['a.ts'], failure).run().status).not.toBe(0); });
it('permits only reviewed literal CJS requires in the exact compatibility files', async () => {
  const { ESLint } = await import('eslint'); const eslint = new ESLint({ ignore: false });
  for (const [filePath, module] of [['scripts/probeEncryptedSqlite.cjs', 'electron'], ['scripts/probeEncryptedSqliteNative.cjs', 'node:os'], ['scripts/lambdaImportResolver.cjs', 'typescript']]) {
    const [result] = await eslint.lintText(`const value = require('${module}'); void value;`, { filePath });
    expect(result.messages.filter(m => m.ruleId === '@typescript-eslint/no-require-imports')).toEqual([]);
  }
  for (const [filePath, code] of [['scripts/lambdaImportResolver.cjs', "require('electron')"], ['scripts/probeEncryptedSqlite.cjs', "require('unknown-module')"], ['scripts/probeEncryptedSqlite.cjs', 'require(process.argv[2])'], ['scripts/not-approved.cjs', "require('node:fs')"]]) {
    const [result] = await eslint.lintText(code, { filePath }); expect(result.messages.some(m => m.ruleId === '@typescript-eslint/no-require-imports')).toBe(true);
  }
});
